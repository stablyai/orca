import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { HandlerContext } from '../dispatch'
import { getOptionalPositiveIntegerFlag } from '../flags'
import { printPluginResult } from '../plugin-authoring/plugin-cli-output'
import { RuntimeClientError } from '../runtime/types'
import { isQualifiedPluginKey } from '../../shared/plugins/manifest/plugin-manifest'
import {
  parsePluginEditorShotActs,
  type PluginEditorShotAct
} from '../../shared/plugins/view/plugin-editor-shot-acts'
import {
  PLUGIN_SHOT_MAX_HEIGHT,
  PLUGIN_SHOT_MAX_WIDTH,
  PLUGIN_SHOT_MIN_HEIGHT,
  PLUGIN_SHOT_MIN_WIDTH
} from '../../shared/rpc-contract/plugins-params'
import { callPlugins, resolveHostPluginPath, stringFlag } from './plugin-runtime'
import { readPluginFolderKey } from './plugin-shot-scenario'

/** What `plugins.shotEditor` answers; `png` is base64. */
type PluginEditorShotReply = {
  pluginKey: string
  editorId: string
  title: string
  filePath: string
  png: string
  width: number
  height: number
  colorScheme: 'light' | 'dark'
  themeApplied: boolean
  themeReason?: string
  settled: boolean
  subscribed: boolean
  errors: string[]
  acted?: number
}

export type PluginEditorShotSaved = Omit<PluginEditorShotReply, 'png' | 'colorScheme'> & {
  path: string
  theme: 'light' | 'dark'
}

// Why above the host's 25s: it waits for the editor to load, then for each act to paint.
const EDITOR_SHOT_RPC_TIMEOUT_MS = 40_000
const EDITOR_SHOT_RPC_ACT_TIMEOUT_MS = 2_000

/** Pixel flags for an editor shot; each takes the host's limits. */
export function parseEditorShotSize(ctx: HandlerContext): { width?: number; height?: number } {
  const width = getOptionalPositiveIntegerFlag(ctx.flags, 'width')
  const height = getOptionalPositiveIntegerFlag(ctx.flags, 'height')
  if (width !== undefined && (width < PLUGIN_SHOT_MIN_WIDTH || width > PLUGIN_SHOT_MAX_WIDTH)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--width takes ${PLUGIN_SHOT_MIN_WIDTH} to ${PLUGIN_SHOT_MAX_WIDTH} pixels.`
    )
  }
  if (
    height !== undefined &&
    (height < PLUGIN_SHOT_MIN_HEIGHT || height > PLUGIN_SHOT_MAX_HEIGHT)
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--height takes ${PLUGIN_SHOT_MIN_HEIGHT} to ${PLUGIN_SHOT_MAX_HEIGHT} pixels.`
    )
  }
  return { ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }) }
}

export function parseEditorShotActs(ctx: HandlerContext): PluginEditorShotAct[] | undefined {
  const json = stringFlag(ctx, 'act')
  if (json === undefined) {
    return undefined
  }
  const parsed = parsePluginEditorShotActs(json)
  if (!parsed.ok) {
    throw new RuntimeClientError('invalid_argument', `--act: ${parsed.error}.`)
  }
  return parsed.acts
}

/** `<dir|plugin-key>`: a local plugin folder names the key it loads under. */
export async function editorShotPluginKey(ctx: HandlerContext): Promise<string> {
  const target = stringFlag(ctx, 'plugin')
  if (target === undefined) {
    throw new RuntimeClientError('invalid_argument', 'Pass the plugin folder or its key.')
  }
  const asPath = isAbsolute(target) ? target : resolve(ctx.cwd, target)
  if (!ctx.client.isRemote && existsSync(asPath)) {
    return readPluginFolderKey(asPath)
  }
  if (!isQualifiedPluginKey(target)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass a plugin folder, or a plugin key such as acme.sketch; `orca plugin list` shows them.'
    )
  }
  return target
}

export function formatPluginEditorShot(shot: PluginEditorShotSaved, requested?: string): string {
  return [
    `Saved ${shot.path} (${shot.width}x${shot.height}, ${shot.theme} theme, ${shot.title} on ${shot.filePath})`,
    ...(requested && !shot.themeApplied
      ? [`  note: ${requested} was not applied (${shot.themeReason ?? 'Orca could not paint it'}).`]
      : []),
    ...(shot.acted ? [`  acted: ${shot.acted} input action(s) sent to the editor`] : []),
    ...shot.errors.map((error) => `  error: ${error}`)
  ].join('\n')
}

/** Opens the file in the plugin's editor on the host, captures it and writes the PNG here. */
export async function runPluginEditorShot(
  ctx: HandlerContext,
  request: {
    editor: string
    colorScheme?: 'light' | 'dark'
    out: string | null
    shotsDir: string
  }
): Promise<void> {
  const pluginKey = await editorShotPluginKey(ctx)
  const acts = parseEditorShotActs(ctx)
  const reply = await callPlugins<PluginEditorShotReply>(
    ctx,
    'plugins.shotEditor',
    {
      pluginKey,
      filePath: resolveHostPluginPath(ctx, request.editor),
      ...(request.colorScheme ? { colorScheme: request.colorScheme } : {}),
      ...parseEditorShotSize(ctx),
      ...(acts ? { acts } : {})
    },
    { timeoutMs: EDITOR_SHOT_RPC_TIMEOUT_MS + (acts?.length ?? 0) * EDITOR_SHOT_RPC_ACT_TIMEOUT_MS }
  )
  const { png, colorScheme, ...rest } = reply
  const path = request.out ?? join(request.shotsDir, `${reply.pluginKey}-${reply.editorId}.png`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, Buffer.from(png, 'base64'))
  const saved: PluginEditorShotSaved = { ...rest, path, theme: colorScheme }
  printPluginResult(ctx, saved, formatPluginEditorShot(saved, request.colorScheme))
  // The PNG is saved either way; a broken editor still fails the command.
  if (!reply.subscribed || reply.errors.length > 0) {
    process.exitCode = 1
  }
}
