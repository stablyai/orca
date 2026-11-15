import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { HandlerContext } from '../../dispatch/dispatch'
import { printPluginResult } from '../plugin-cli-output'
import { RuntimeClientError } from '../../runtime/connection/types'
import { callPlugins } from '../plugin-runtime'
import { editorShotPluginKey } from './plugin-shot-editor'

type ChromeRegion = 'status-bar' | 'window'

/** What `plugins.shotChrome` answers; `png` is base64. */
type PluginChromeShotReply = {
  pluginKey: string
  region: ChromeRegion
  png: string
  width: number
  height: number
  colorScheme: 'light' | 'dark'
  themeApplied: boolean
  themeReason?: string
  errors: string[]
}

export type PluginChromeShotSaved = Omit<PluginChromeShotReply, 'png' | 'colorScheme'> & {
  path: string
  theme: 'light' | 'dark'
}

// Above the host's 10s for the renderer to repaint and measure.
const CHROME_SHOT_RPC_TIMEOUT_MS = 20_000

/** `--status-bar` or `--window`, or null for a panel or editor shot. */
export function chromeShotRegion(ctx: HandlerContext): ChromeRegion | null {
  const statusBar = ctx.flags.has('status-bar')
  const window = ctx.flags.has('window')
  if (statusBar && window) {
    throw new RuntimeClientError('invalid_argument', 'Pass --status-bar or --window, not both.')
  }
  if (!statusBar && !window) {
    return null
  }
  const other = ['panel', 'editor', 'scenario', 'act', 'width', 'height', 'in-place'].find((flag) =>
    ctx.flags.has(flag)
  )
  if (other) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--${other} is not for a ${statusBar ? '--status-bar' : '--window'} shot; it takes --theme and --out.`
    )
  }
  return statusBar ? 'status-bar' : 'window'
}

export function formatPluginChromeShot(shot: PluginChromeShotSaved, requested?: string): string {
  return [
    `Saved ${shot.path} (${shot.width}x${shot.height}, ${shot.theme} theme, Orca's ${shot.region === 'window' ? 'window' : 'status bar'})`,
    ...(requested && !shot.themeApplied
      ? [`  note: ${requested} was not applied (${shot.themeReason ?? 'Orca could not paint it'}).`]
      : []),
    ...shot.errors.map((error) => `  error: ${error}`)
  ].join('\n')
}

/** Captures Orca's status bar or whole window on the host and writes the PNG here. */
export async function runPluginChromeShot(
  ctx: HandlerContext,
  request: {
    region: ChromeRegion
    colorScheme: 'light' | 'dark' | undefined
    out: string | null
    shotsDir: string
  }
): Promise<void> {
  const pluginKey = await editorShotPluginKey(ctx)
  const reply = await callPlugins<PluginChromeShotReply>(
    ctx,
    'plugins.shotChrome',
    {
      pluginKey,
      region: request.region,
      ...(request.colorScheme ? { colorScheme: request.colorScheme } : {})
    },
    { timeoutMs: CHROME_SHOT_RPC_TIMEOUT_MS }
  )
  const { png, colorScheme, ...rest } = reply
  const path = request.out ?? join(request.shotsDir, `${reply.pluginKey}-${reply.region}.png`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, Buffer.from(png, 'base64'))
  const saved: PluginChromeShotSaved = { ...rest, path, theme: colorScheme }
  printPluginResult(ctx, saved, formatPluginChromeShot(saved, request.colorScheme))
}
