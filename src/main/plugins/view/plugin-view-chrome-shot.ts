import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type {
  PluginChromeRegion,
  PluginViewColorScheme
} from '../../../shared/plugins/view/plugin-view-protocol'
import { PluginCliError } from '../../../shared/plugins/approval/plugin-cli-approval'
import { capturePluginPanelPng, withPaintingWhileHidden } from './plugin-view-capture'
import { requestPluginViewFromRenderer } from './plugin-view-renderer-relay'
import { pluginShotThemeDecision } from './plugin-shot-policy'
import { resolvePluginViewLive } from './plugin-view-target'
import type { PluginViewDesktopDeps } from './plugin-view-desktop'

export type PluginChromeShotResult = {
  pluginKey: string
  region: PluginChromeRegion
  /** Base64 PNG, one pixel per window point. */
  png: string
  width: number
  height: number
  colorScheme: PluginViewColorScheme
  themeApplied: boolean
  themeReason?: string
  /** What the plugin logged as errors during the capture. */
  errors: string[]
}

const CHROME_TIMEOUT_MS = 10_000
const MAX_ERRORS = 20

export type OrcaChromeCapture = Pick<
  PluginChromeShotResult,
  'region' | 'png' | 'width' | 'height' | 'colorScheme' | 'themeApplied' | 'themeReason'
>

/** Captures Orca's status bar or whole window, hidden window included, in the asked theme when
 *  nobody can see the window; the theme is put back after. */
export async function captureOrcaChrome(
  contents: WebContents,
  windowShown: boolean,
  params: { region: PluginChromeRegion; colorScheme?: PluginViewColorScheme }
): Promise<OrcaChromeCapture> {
  const { region } = params
  const { colorScheme, themeReason } = pluginShotThemeDecision(params.colorScheme, windowShown)
  const captureId = randomUUID()
  return withPaintingWhileHidden([contents], async () => {
    try {
      const reply = await requestPluginViewFromRenderer(
        contents,
        {
          kind: 'capture-chrome',
          region,
          ...(colorScheme === undefined ? {} : { colorScheme }),
          captureId
        },
        CHROME_TIMEOUT_MS
      )
      if (!reply.ok) {
        throw new PluginCliError('invalid_argument', reply.message, {
          reason: reply.code,
          nextSteps: [
            'Show the status bar from the View menu, or leave Settings, then run this again.'
          ]
        })
      }
      if (!reply.panel) {
        throw new Error(`Orca did not report where its ${region} is drawn.`)
      }
      const image = await capturePluginPanelPng(contents, reply.panel.rect)
      return {
        region,
        png: image.png.toString('base64'),
        width: image.width,
        height: image.height,
        colorScheme: reply.panel.colorScheme,
        themeApplied: reply.panel.themeApplied,
        ...(themeReason ? { themeReason } : {})
      }
    } finally {
      // Puts back the theme.
      await requestPluginViewFromRenderer(
        contents,
        { kind: 'end-capture', captureId },
        CHROME_TIMEOUT_MS
      ).catch(() => null)
    }
  })
}

/** `shot --status-bar` / `--window`: captures Orca's own chrome, hidden window included, where
 *  plugins draw outside their panels (status bar items, for one). */
export async function shootPluginChrome(
  deps: PluginViewDesktopDeps,
  contents: WebContents,
  params: { pluginKey: string; region: PluginChromeRegion; colorScheme?: PluginViewColorScheme }
): Promise<PluginChromeShotResult> {
  const { pluginKey, region } = params
  await resolvePluginViewLive(deps.source, pluginKey)
  const { cursor } = deps.logsSince(pluginKey)
  const capture = await captureOrcaChrome(contents, deps.windowShown(), {
    region,
    ...(params.colorScheme === undefined ? {} : { colorScheme: params.colorScheme })
  })
  const logged = deps
    .logsSince(pluginKey, cursor)
    .lines.filter((line) => line.level === 'error')
    .map((line) => line.line)
  return { pluginKey, ...capture, errors: logged.slice(0, MAX_ERRORS) }
}
