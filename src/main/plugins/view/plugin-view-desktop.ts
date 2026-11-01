import type { WebContents } from 'electron'
import {
  PLUGIN_VIEW_NO_WORKSPACE_CODE,
  PLUGIN_VIEW_NOT_SHOWN_CODE,
  type PluginViewColorScheme,
  type PluginViewDrawnPanel,
  type PluginViewReply
} from '../../../shared/plugins/view/plugin-view-protocol'
import { PluginCliError } from '../../../shared/plugins/approval/plugin-cli-approval'
import {
  capturePluginPanelPng,
  settlePluginFrameGuest,
  withPaintingWhileHidden
} from './plugin-view-capture'
import { requestPluginViewFromRenderer } from './plugin-view-renderer-relay'
import { pluginShotThemeDecision } from './plugin-shot-policy'
import {
  resolvePluginViewEditor,
  resolvePluginViewPanel,
  type PluginViewSource
} from './plugin-view-target'

export type PluginViewOpenResult =
  | { pluginKey: string; kind: 'panel'; panelId: string; title: string }
  | { pluginKey: string; kind: 'editor'; editorId: string; title: string; filePath: string }

export type PluginShotResult = {
  pluginKey: string
  panelId: string
  title: string
  ui: PluginViewDrawnPanel['ui']
  /** Base64 PNG, one pixel per window point. */
  png: string
  width: number
  height: number
  colorScheme: PluginViewColorScheme
  themeApplied: boolean
  /** Why `--theme` was not applied, when it was asked for and not applied. */
  themeReason?: string
  /** False when the panel had not finished drawing by the timeout. */
  settled: boolean
  /** Errors the panel logged during the capture and the banner it shows, if any. */
  errors: string[]
}

/** `ifShown` and the panel was not on screen: nothing was opened, switched or captured. */
export type PluginShotNotShown = {
  pluginKey: string
  panelId: string
  title: string
  notShown: string
}

export type PluginViewDesktop = {
  open(params: {
    pluginKey: string
    panelId?: string
    filePath?: string
  }): Promise<PluginViewOpenResult>
  shot(params: {
    pluginKey: string
    panelId?: string
    colorScheme?: PluginViewColorScheme
    width?: number
    ifShown?: boolean
  }): Promise<PluginShotResult | PluginShotNotShown>
}

export type PluginViewDesktopDeps = {
  /** The main window's renderer, or null when Orca has no window open. */
  rendererContents(): WebContents | null
  /** The main window is on screen: visible and not minimized. */
  windowShown(): boolean
  source: PluginViewSource
  logsSince(
    pluginKey: string,
    cursor?: string
  ): { lines: readonly { level: string; line: string }[]; cursor: string }
  guestsOf(pluginKey: string): WebContents[]
}

const OPEN_TIMEOUT_MS = 10_000
// Why 15s: a cold components panel transpiles and boots its guest before the first tree.
const RENDER_TIMEOUT_MS = 15_000
const REPLY_GRACE_MS = 5_000
const MAX_ERRORS = 20

function failed(reply: PluginViewReply): PluginCliError | null {
  return reply.ok
    ? null
    : new PluginCliError('invalid_argument', reply.message, {
        reason: reply.code,
        nextSteps:
          reply.code === PLUGIN_VIEW_NO_WORKSPACE_CODE
            ? ['Open a workspace in Orca, then run this again.']
            : []
      })
}

export function createPluginViewDesktop(deps: PluginViewDesktopDeps): PluginViewDesktop {
  const requireContents = (): WebContents => {
    const contents = deps.rendererContents()
    if (!contents || contents.isDestroyed()) {
      throw new Error('Orca has no open window to show the plugin in; open one, then try again.')
    }
    return contents
  }

  return {
    open: async ({ pluginKey, panelId, filePath }) => {
      if (filePath !== undefined) {
        const editor = await resolvePluginViewEditor(deps.source, pluginKey, filePath)
        const reply = await requestPluginViewFromRenderer(
          requireContents(),
          { kind: 'open-editor', pluginKey, editorId: editor.editorId, filePath },
          OPEN_TIMEOUT_MS
        )
        const error = failed(reply)
        if (error) {
          throw error
        }
        return {
          pluginKey,
          kind: 'editor',
          editorId: editor.editorId,
          title: editor.title,
          filePath
        }
      }
      const panel = await resolvePluginViewPanel(deps.source, pluginKey, panelId)
      const reply = await requestPluginViewFromRenderer(
        requireContents(),
        { kind: 'open-panel', pluginKey, panelId: panel.panelId },
        OPEN_TIMEOUT_MS
      )
      const error = failed(reply)
      if (error) {
        throw error
      }
      return { pluginKey, kind: 'panel', panelId: panel.panelId, title: panel.title }
    },

    shot: async ({ pluginKey, panelId, colorScheme: requested, width, ifShown }) => {
      const panel = await resolvePluginViewPanel(deps.source, pluginKey, panelId)
      const contents = requireContents()
      const { colorScheme, themeReason } = pluginShotThemeDecision(requested, deps.windowShown())
      const { cursor } = deps.logsSince(pluginKey)
      return withPaintingWhileHidden([contents, ...deps.guestsOf(pluginKey)], async () => {
        try {
          const reply = await requestPluginViewFromRenderer(
            contents,
            {
              kind: 'open-panel',
              pluginKey,
              panelId: panel.panelId,
              capture: {
                guestRevision: panel.guestRevision,
                ...(width === undefined ? {} : { width }),
                ...(colorScheme === undefined ? {} : { colorScheme }),
                ...(ifShown ? { ifShown: true } : {}),
                timeoutMs: RENDER_TIMEOUT_MS
              }
            },
            RENDER_TIMEOUT_MS + REPLY_GRACE_MS
          )
          if (ifShown && !reply.ok && reply.code === PLUGIN_VIEW_NOT_SHOWN_CODE) {
            return {
              pluginKey,
              panelId: panel.panelId,
              title: panel.title,
              notShown: reply.message
            }
          }
          const error = failed(reply)
          if (error) {
            throw error
          }
          const drawn = reply.ok ? reply.panel : undefined
          if (!drawn) {
            throw new Error('Orca did not report where the panel is drawn.')
          }
          if (drawn.ui === 'html') {
            await settlePluginFrameGuest(
              deps.guestsOf(pluginKey).find((guest) => guest.getURL() === drawn.guestUrl)
            )
          }
          const image = await capturePluginPanelPng(contents, drawn.rect)
          const logged = deps
            .logsSince(pluginKey, cursor)
            .lines.filter((line) => line.level === 'error')
            .map((line) => line.line)
          return {
            pluginKey,
            panelId: panel.panelId,
            title: panel.title,
            ui: drawn.ui,
            png: image.png.toString('base64'),
            width: image.width,
            height: image.height,
            colorScheme: drawn.colorScheme,
            themeApplied: drawn.themeApplied,
            ...(themeReason ? { themeReason } : {}),
            settled: drawn.settled,
            errors: [...(drawn.issue ? [drawn.issue] : []), ...logged].slice(0, MAX_ERRORS)
          }
        } finally {
          await requestPluginViewFromRenderer(
            contents,
            { kind: 'end-capture' },
            OPEN_TIMEOUT_MS
          ).catch(() => undefined)
        }
      })
    }
  }
}
