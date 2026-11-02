import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime/types'
import type { PluginHostListEntry } from '../../shared/plugins/plugin-list-entry'
import {
  isQualifiedPluginKey,
  parsePluginManifest,
  qualifiedPluginKey,
  type PluginManifest
} from '../../shared/plugins/manifest/plugin-manifest'
import {
  localPluginPublisher,
  withPluginPublisher
} from '../../shared/plugins/installation/plugin-publisher-derivation'
import { callPlugins } from './plugin-runtime'
import { enclosingPluginFolder } from './plugin-shot-default-dir'
import type { PluginShotReply, PluginShotSaved } from './plugin-view'

/** What `plugins.shotReplay` answers: a shot of the drawn scenario tree. */
type PluginShotReplayReply = PluginShotReply & { replay?: true; scenario?: string }

export type PluginShotScenarioRequest = {
  target: string
  scenario: string
  panelId?: string
  colorScheme?: 'light' | 'dark'
  width?: number
  out?: string
}

// Why above the host's: it waits up to 10s for the preview to draw and answer, then captures.
const REPLAY_RPC_TIMEOUT_MS = 30_000

export const PLUGIN_SHOT_REPLAY_NOTE =
  "a still frame of what the scenario rendered, drawn apart from the plugin: host-owned control values start from the tree's props and images show their placeholder"

function refuse(code: string, message: string, nextSteps: string[] = []): RuntimeClientError {
  return new RuntimeClientError(code, message, nextSteps.length > 0 ? { nextSteps } : undefined)
}

/** Why local only: the scenario runs the plugin's code here, then Orca on this machine draws it. */
function requireLocal(ctx: HandlerContext): void {
  if (process.env.ORCA_CLI_CWD || ctx.client.isRemote) {
    throw refuse(
      'invalid_environment',
      "shot --scenario runs the plugin's code on this machine and shows it in the Orca on this machine, so it does not reach another host. Run it where Orca and the plugin folder are, without --environment."
    )
  }
}

async function readManifest(dir: string): Promise<PluginManifest> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(dir, 'orca-plugin.json'), 'utf8'))
  } catch (error) {
    throw refuse(
      'invalid_argument',
      `${dir} has no readable orca-plugin.json: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const parsed = parsePluginManifest(raw)
  if (!parsed.ok) {
    throw refuse('plugin_invalid', `${dir}: ${parsed.error}`, [
      `\`orca plugin validate ${dir}\` lists every problem.`
    ])
  }
  return parsed.manifest
}

// Why derived: a folder loads under its declared publisher, else `local`, like dev discovery.
const folderKey = (manifest: PluginManifest): string =>
  qualifiedPluginKey(withPluginPublisher(manifest, localPluginPublisher(manifest.publisher)))

/**
 * The plugin folder to render: the argument when it is a folder, else for a key the dev folder
 * this command runs in. The host does not publish dev folder paths, so it cannot name one.
 */
async function resolveFolder(
  ctx: HandlerContext,
  target: string
): Promise<{ dir: string; manifest: PluginManifest; pluginKey: string }> {
  const asPath = isAbsolute(target) ? target : resolve(ctx.cwd, target)
  if (existsSync(asPath) || !isQualifiedPluginKey(target)) {
    const manifest = await readManifest(asPath)
    return { dir: asPath, manifest, pluginKey: folderKey(manifest) }
  }
  const plugins = await callPlugins<PluginHostListEntry[]>(ctx, 'plugins.list')
  const entry = plugins.find((plugin) => plugin.pluginKey === target)
  if (!entry) {
    throw refuse('plugin_not_found', `Orca has no plugin ${target}.`, [
      'Pass the plugin folder instead: `orca plugin shot <dir> --scenario <name>`.'
    ])
  }
  if (!entry.isDev) {
    throw refuse(
      'invalid_argument',
      `${target} is installed, not a development folder; --scenario renders a plugin's own source folder.`,
      ['Pass the plugin folder: `orca plugin shot <dir> --scenario <name>`.']
    )
  }
  const enclosing = enclosingPluginFolder(ctx.cwd)
  const manifest = enclosing ? await readManifest(enclosing).catch(() => null) : null
  if (!enclosing || !manifest || folderKey(manifest) !== target) {
    throw refuse(
      'invalid_argument',
      `Run this inside ${target}'s folder, or pass the folder; Orca does not share where a development folder is.`,
      [`orca plugin shot <dir> --scenario <name>`]
    )
  }
  return { dir: enclosing, manifest, pluginKey: target }
}

function scenarioPanel(
  manifest: PluginManifest,
  pluginKey: string,
  panelId: string | undefined
): { id: string; title: string; entry: string } {
  const panels = manifest.contributes.panels
  const panel =
    panelId === undefined
      ? panels.find((each) => each.ui === 'components')
      : panels.find((each) => each.id === panelId)
  if (!panel) {
    throw refuse(
      'invalid_argument',
      panelId === undefined
        ? `${pluginKey} has no components panel; --scenario renders components panels only.`
        : `${pluginKey} has no panel ${panelId}; its panels: ${panels.map((each) => each.id).join(', ') || 'none'}.`
    )
  }
  if (panel.ui !== 'components') {
    throw refuse(
      'invalid_argument',
      `${pluginKey}/${panel.id} is an html panel; --scenario renders components panels only.`
    )
  }
  return { id: panel.id, title: panel.title, entry: panel.entry }
}

/** A scenario name as a file-name part: anything but letters, digits, `.`, `_` and `-` becomes `-`. */
export function pluginScenarioFileStem(scenario: string): string {
  return scenario.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '') || 'scenario'
}

/**
 * `orca plugin shot --scenario`: renders the panel in the named `.check.ts` scenario on this
 * machine (as `orca plugin check` does, against a stand-in host and the plugin's worker mounted
 * here), then has Orca draw that tree apart from the plugin and capture it.
 */
export async function takePluginScenarioShot(
  ctx: HandlerContext,
  request: PluginShotScenarioRequest
): Promise<PluginShotSaved & { replay: true; scenario: string; notes: string[] }> {
  requireLocal(ctx)
  const { dir, manifest, pluginKey } = await resolveFolder(ctx, request.target)
  const panel = scenarioPanel(manifest, pluginKey, request.panelId)
  // Lazy: the check pulls in the declarative tree validator and the Node selection.
  const check = await import('../plugin-authoring/plugin-panel-check.js')
  const names = await check.readPluginCheckScenarioNames(dir, panel.entry).catch((error) => {
    throw refuse('invalid_argument', error instanceof Error ? error.message : String(error))
  })
  if (!names.includes(request.scenario)) {
    throw refuse(
      'invalid_argument',
      names.length === 0
        ? `${panel.entry} has no scenarios: add ${panel.entry.replace(/\.[^./]+$/, '')}.check.ts beside it.`
        : `${pluginKey}/${panel.id} has no scenario "${request.scenario}"; its scenarios: ${names.join(', ')}.`
    )
  }
  const [rendered] = await check.checkPluginPanels(dir, {
    panel: panel.id,
    scenario: request.scenario,
    drawnTree: true
  })
  const issues = (rendered?.issues ?? []).map(
    (issue) => `${issue.location ?? panel.entry}: ${issue.message}`
  )
  if (!rendered?.drawnTree) {
    throw refuse(
      'plugin_check_failed',
      [
        `${pluginKey}/${panel.id} drew nothing to shoot in scenario "${request.scenario}".`,
        ...(rendered ? check.formatPluginPanelCheck(rendered) : [])
      ].join('\n')
    )
  }
  const reply = await callPlugins<PluginShotReplayReply>(
    ctx,
    'plugins.shotReplay',
    {
      pluginKey,
      panelId: panel.id,
      title: panel.title,
      scenario: request.scenario,
      tree: rendered.drawnTree,
      ...(request.colorScheme === undefined ? {} : { colorScheme: request.colorScheme }),
      ...(request.width === undefined ? {} : { width: request.width })
    },
    { timeoutMs: REPLAY_RPC_TIMEOUT_MS }
  )
  if (reply.replay !== true) {
    throw refuse(
      'runtime_unsupported',
      'This Orca does not draw shot --scenario previews; update Orca, then run it again.'
    )
  }
  const path =
    request.out ??
    join(
      dir,
      '.orca',
      'shots',
      `${pluginKey}-${panel.id}.${pluginScenarioFileStem(request.scenario)}.png`
    )
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, Buffer.from(reply.png, 'base64'))
  return {
    path,
    pluginKey,
    panelId: panel.id,
    width: reply.width,
    height: reply.height,
    theme: reply.colorScheme,
    themeApplied: reply.themeApplied,
    ...(reply.themeReason ? { themeReason: reply.themeReason } : {}),
    settled: reply.settled,
    errors: [...issues, ...reply.errors],
    replay: true,
    scenario: request.scenario,
    notes: [PLUGIN_SHOT_REPLAY_NOTE]
  }
}
