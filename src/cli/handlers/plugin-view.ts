import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalPositiveIntegerFlag } from '../flags'
import { printPluginResult } from '../plugin-authoring/plugin-cli-output'
import { RuntimeClientError } from '../runtime/types'
import {
  PLUGIN_SHOT_MAX_WIDTH,
  PLUGIN_SHOT_MIN_WIDTH
} from '../../shared/rpc-contract/plugins-params'
import {
  parsePluginShotActs,
  type PluginShotAct,
  type PluginShotActResult
} from '../../shared/plugins/view/plugin-shot-acts'
import { callPlugins, requirePluginKey, resolveHostPluginPath, stringFlag } from './plugin-runtime'
import { defaultPluginShotsDir } from './plugin-shot-default-dir'
import { takePluginScenarioShot } from './plugin-shot-scenario'

/** What `plugins.shot` answers; `png` is base64. */
export type PluginShotReply = {
  pluginKey: string
  panelId: string
  title: string
  ui: 'components' | 'html'
  png: string
  width: number
  height: number
  colorScheme: 'light' | 'dark'
  themeApplied: boolean
  /** Absent on hosts that predate it. */
  themeReason?: string
  settled: boolean
  errors: string[]
  /** Host calls still unanswered at the capture (components panels); absent on older hosts. */
  pendingRequests?: number
  /** Present when `acts` were sent; absent from hosts that predate --act. */
  actions?: PluginShotActResult[]
  /** With acts: the panel's atoms were put back after the capture; absent on older hosts. */
  restored?: boolean
}

/** `ifShown` and the panel was not on screen: the host opened, switched and captured nothing. */
export type PluginShotNotShown = { pluginKey: string; panelId: string; notShown: string }

export type PluginShotSaved = {
  path: string
  pluginKey: string
  panelId: string
  width: number
  height: number
  theme: 'light' | 'dark'
  themeApplied: boolean
  themeReason?: string
  settled: boolean
  errors: string[]
  pendingRequests?: number
  actions?: PluginShotActResult[]
  restored?: boolean
  /** `--scenario`: a CLI-rendered scenario tree, drawn apart from the plugin. */
  replay?: true
  scenario?: string
  notes?: string[]
}

type PluginOpenReply =
  | { pluginKey: string; kind: 'panel'; panelId: string; title: string }
  | { pluginKey: string; kind: 'editor'; editorId: string; title: string; filePath: string }

// Why above the host's 20s: the host waits up to 15s for the panel to draw, then captures.
const SHOT_RPC_TIMEOUT_MS = 30_000
// Above the host's 4s per act.
const SHOT_RPC_ACT_TIMEOUT_MS = 5_000

/** `.orca/` ignores itself in Git, so shots next to a plugin never get committed. */
export function defaultPluginShotPath(dir: string, pluginKey: string, panelId: string): string {
  return join(dir, `${pluginKey}-${panelId}.png`)
}

/** The PNG lands on the machine that runs the CLI, also with --environment. */
export function resolveLocalShotPath(ctx: HandlerContext, value: string): string {
  if (process.env.ORCA_CLI_CWD) {
    throw new RuntimeClientError(
      'invalid_environment',
      'orca plugin shot writes the PNG on the machine that runs it, but this shell forwards orca to the Orca host. Run it on the machine that should keep the image.'
    )
  }
  return isAbsolute(value) ? value : resolve(ctx.cwd, value)
}

function parseWidth(ctx: HandlerContext): number | undefined {
  const width = getOptionalPositiveIntegerFlag(ctx.flags, 'width')
  if (width !== undefined && (width < PLUGIN_SHOT_MIN_WIDTH || width > PLUGIN_SHOT_MAX_WIDTH)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--width takes ${PLUGIN_SHOT_MIN_WIDTH} to ${PLUGIN_SHOT_MAX_WIDTH} pixels.`
    )
  }
  return width
}

function parseTheme(ctx: HandlerContext): 'light' | 'dark' | undefined {
  const theme = stringFlag(ctx, 'theme')
  if (theme === undefined || theme === 'light' || theme === 'dark') {
    return theme
  }
  throw new RuntimeClientError('invalid_argument', '--theme takes light or dark.')
}

type PluginShotRequest = {
  pluginKey: string
  panelId?: string
  colorScheme?: 'light' | 'dark'
  width?: number
  acts?: PluginShotAct[]
  outFor: (panelId: string) => string
}

async function shoot(
  ctx: HandlerContext,
  request: PluginShotRequest & { ifShown?: true }
): Promise<PluginShotSaved | PluginShotNotShown> {
  const { outFor, ...params } = request
  const reply = await callPlugins<PluginShotReply | PluginShotNotShown>(
    ctx,
    'plugins.shot',
    params,
    { timeoutMs: SHOT_RPC_TIMEOUT_MS + (params.acts?.length ?? 0) * SHOT_RPC_ACT_TIMEOUT_MS }
  )
  if ('notShown' in reply) {
    return { pluginKey: reply.pluginKey, panelId: reply.panelId, notShown: reply.notShown }
  }
  if (params.acts && !reply.actions) {
    throw new RuntimeClientError(
      'runtime_unsupported',
      'This Orca does not run shot --act (it captured without acting); update Orca, then run it again.'
    )
  }
  const path = outFor(reply.panelId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, Buffer.from(reply.png, 'base64'))
  return {
    path,
    pluginKey: reply.pluginKey,
    panelId: reply.panelId,
    width: reply.width,
    height: reply.height,
    theme: reply.colorScheme,
    themeApplied: reply.themeApplied,
    ...(reply.themeReason ? { themeReason: reply.themeReason } : {}),
    settled: reply.settled,
    errors: reply.errors,
    ...(reply.pendingRequests === undefined ? {} : { pendingRequests: reply.pendingRequests }),
    ...(reply.actions ? { actions: reply.actions } : {}),
    ...(reply.restored === undefined ? {} : { restored: reply.restored })
  }
}

/** Shows the panel, captures it on the host and writes it to `outFor(panelId)` here. */
export async function takePluginShot(
  ctx: HandlerContext,
  request: PluginShotRequest
): Promise<PluginShotSaved> {
  const shot = await shoot(ctx, request)
  if ('notShown' in shot) {
    throw new RuntimeClientError('runtime_error', `The panel is not shown: ${shot.notShown}.`)
  }
  return shot
}

/** Captures only while the panel is the open right-sidebar tab; never opens or switches it. */
export function takePluginShotIfShown(
  ctx: HandlerContext,
  request: PluginShotRequest
): Promise<PluginShotSaved | PluginShotNotShown> {
  return shoot(ctx, { ...request, ifShown: true })
}

export function formatPluginShot(shot: PluginShotSaved, requestedTheme?: string): string {
  return [
    `Saved ${shot.path} (${shot.width}x${shot.height}, ${shot.theme} theme${shot.scenario === undefined ? '' : `, scenario "${shot.scenario}"`})`,
    ...(shot.notes ?? []).map((note) => `  note: ${note}.`),
    ...(requestedTheme && !shot.themeApplied
      ? [
          `  note: ${requestedTheme} was not applied (${shot.themeReason ?? 'Orca could not paint it'}); it shows ${shot.theme}.`
        ]
      : []),
    ...(shot.settled
      ? []
      : ['  note: the panel had not finished drawing; this is what it showed.']),
    ...(shot.pendingRequests
      ? [
          `  note: ${shot.pendingRequests} host call(s) (plugin.request included) were unanswered after 3s; the panel may still show its loading state.`
        ]
      : []),
    ...(shot.actions ?? []).map((action, index) =>
      action.ok ? `  act ${index + 1}: ok` : `  act ${index + 1} failed: ${action.error}`
    ),
    ...(shot.restored === false
      ? ['  note: the panel reloaded during --act, so its acted state was not put back.']
      : []),
    ...shot.errors.map((error) => `  error: ${error}`)
  ].join('\n')
}

function parseActs(ctx: HandlerContext): PluginShotAct[] | undefined {
  const json = stringFlag(ctx, 'act')
  if (json === undefined) {
    return undefined
  }
  const parsed = parsePluginShotActs(json)
  if (!parsed.ok) {
    throw new RuntimeClientError('invalid_argument', `--act: ${parsed.error}.`)
  }
  return parsed.acts
}

async function scenarioShot(ctx: HandlerContext, scenario: string): Promise<void> {
  if (stringFlag(ctx, 'act') !== undefined) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--act drives the live panel and --scenario draws a still frame apart from it; pass one.'
    )
  }
  const target = stringFlag(ctx, 'plugin')
  if (target === undefined) {
    throw new RuntimeClientError('invalid_argument', 'Pass the plugin folder or its key.')
  }
  const colorScheme = parseTheme(ctx)
  const out = stringFlag(ctx, 'out')
  const panelId = stringFlag(ctx, 'panel')
  const width = parseWidth(ctx)
  const shot = await takePluginScenarioShot(ctx, {
    target,
    scenario,
    ...(panelId === undefined ? {} : { panelId }),
    ...(colorScheme === undefined ? {} : { colorScheme }),
    ...(width === undefined ? {} : { width }),
    ...(out === undefined ? {} : { out: resolveLocalShotPath(ctx, out) })
  })
  printPluginResult(ctx, shot, formatPluginShot(shot, colorScheme))
}

export const PLUGIN_VIEW_HANDLERS: Record<string, CommandHandler> = {
  'plugin open': async (ctx) => {
    const pluginKey = requirePluginKey(ctx)
    const panelId = stringFlag(ctx, 'panel')
    const editor = stringFlag(ctx, 'editor')
    if (panelId !== undefined && editor !== undefined) {
      throw new RuntimeClientError('invalid_argument', 'Pass --panel or --editor, not both.')
    }
    const result = await callPlugins<PluginOpenReply>(ctx, 'plugins.open', {
      pluginKey,
      ...(panelId === undefined ? {} : { panelId }),
      ...(editor === undefined ? {} : { filePath: resolveHostPluginPath(ctx, editor) })
    })
    printPluginResult(
      ctx,
      result,
      result.kind === 'panel'
        ? `Showing ${result.title} (${result.pluginKey}/${result.panelId}) in Orca's right sidebar.`
        : `Opened ${result.filePath} in ${result.title} (${result.pluginKey}/${result.editorId}).`
    )
  },
  'plugin shot': async (ctx) => {
    const scenario = stringFlag(ctx, 'scenario')
    if (scenario !== undefined) {
      await scenarioShot(ctx, scenario)
      return
    }
    const pluginKey = requirePluginKey(ctx)
    const colorScheme = parseTheme(ctx)
    const out = stringFlag(ctx, 'out')
    const outPath = out === undefined ? null : resolveLocalShotPath(ctx, out)
    const shotsDir = resolveLocalShotPath(ctx, defaultPluginShotsDir(ctx.cwd))
    const panelId = stringFlag(ctx, 'panel')
    const width = parseWidth(ctx)
    const acts = parseActs(ctx)
    const shot = await takePluginShot(ctx, {
      pluginKey,
      ...(panelId === undefined ? {} : { panelId }),
      ...(colorScheme === undefined ? {} : { colorScheme }),
      ...(width === undefined ? {} : { width }),
      ...(acts ? { acts } : {}),
      outFor: (shotPanelId) => outPath ?? defaultPluginShotPath(shotsDir, pluginKey, shotPanelId)
    })
    printPluginResult(ctx, shot, formatPluginShot(shot, colorScheme))
    // The PNG is saved either way; a failed act still fails the command.
    if (shot.actions?.some((action) => !action.ok)) {
      process.exitCode = 1
    }
  }
}
