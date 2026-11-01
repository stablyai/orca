import type { WebContents } from 'electron'
import type { z } from 'zod'
import type { PluginShotReplayParams } from '../../../shared/rpc-contract/plugins-params'
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
  type BitmapImageFactory,
  settlePluginFrameGuest,
  withPaintingWhileHidden
} from './plugin-view-capture'
import { requestPluginViewFromRenderer } from './plugin-view-renderer-relay'
import { pluginShotActRefusal, pluginShotThemeDecision } from './plugin-shot-policy'
import { shootPluginReplay, type PluginShotReplayResult } from './plugin-view-replay-shot'
import type {
  PluginShotAct,
  PluginShotActResult
} from '../../../shared/plugins/view/plugin-shot-acts'
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
  /** Host calls (`plugin.request` included) still unanswered at the capture; components only. */
  pendingRequests?: number
  /** One result per `acts` entry, when acts were asked for. */
  actions?: PluginShotActResult[]
  /** With acts: the panel's atoms were put back after the capture (false: its guest reloaded). */
  restored?: boolean
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
    acts?: PluginShotAct[]
  }): Promise<PluginShotResult | PluginShotNotShown>
  /** `shot --scenario`: captures a CLI-rendered tree without opening the plugin's panel. */
  shotReplay(params: z.infer<typeof PluginShotReplayParams>): Promise<PluginShotReplayResult>
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
  /** `nativeImage.createFromBitmap`, to draw an html panel's guest over the window capture. */
  imageFromBitmap: BitmapImageFactory
}

const OPEN_TIMEOUT_MS = 10_000
// Why 15s: a cold components panel transpiles and boots its guest before the first tree.
const RENDER_TIMEOUT_MS = 15_000
const REPLY_GRACE_MS = 5_000
// Why: each act may wait up to 3s for the panel to settle, plus the frames that paint it.
const ACT_TIMEOUT_MS = 4_000
// Why: after drawing, a shot waits up to 3s more for the panel's worker to answer.
const SETTLE_TIMEOUT_MS = 3_500
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

    shotReplay: (params) =>
      shootPluginReplay({ contents: requireContents(), windowShown: deps.windowShown() }, params),

    shot: async ({ pluginKey, panelId, colorScheme: requested, width, ifShown, acts }) => {
      const panel = await resolvePluginViewPanel(deps.source, pluginKey, panelId)
      const contents = requireContents()
      const actRefusal = acts ? pluginShotActRefusal(panel.ui, deps.windowShown()) : null
      if (actRefusal) {
        throw new PluginCliError('invalid_argument', actRefusal.message, {
          reason: actRefusal.reason,
          nextSteps: actRefusal.nextSteps
        })
      }
      const actsTimeoutMs = (acts?.length ?? 0) * ACT_TIMEOUT_MS
      const { colorScheme, themeReason } = pluginShotThemeDecision(requested, deps.windowShown())
      const { cursor } = deps.logsSince(pluginKey)
      return withPaintingWhileHidden([contents, ...deps.guestsOf(pluginKey)], async () => {
        let restored: boolean | undefined
        const shot = await (async (): Promise<PluginShotResult | PluginShotNotShown> => {
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
                  ...(acts ? { acts } : {}),
                  timeoutMs: RENDER_TIMEOUT_MS
                }
              },
              RENDER_TIMEOUT_MS + SETTLE_TIMEOUT_MS + actsTimeoutMs + REPLY_GRACE_MS
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
            const guest =
              drawn.ui === 'html'
                ? deps.guestsOf(pluginKey).find((each) => each.getURL() === drawn.guestUrl)
                : undefined
            await settlePluginFrameGuest(guest)
            const image = await capturePluginPanelPng(
              contents,
              drawn.rect,
              guest && drawn.guestRect
                ? { contents: guest, rect: drawn.guestRect, fromBitmap: deps.imageFromBitmap }
                : undefined
            )
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
              errors: [...(drawn.issue ? [drawn.issue] : []), ...logged].slice(0, MAX_ERRORS),
              ...(drawn.pendingRequests === undefined
                ? {}
                : { pendingRequests: drawn.pendingRequests }),
              ...(drawn.actions ? { actions: drawn.actions } : {})
            }
          } finally {
            const ended = await requestPluginViewFromRenderer(
              contents,
              { kind: 'end-capture' },
              OPEN_TIMEOUT_MS
            ).catch(() => null)
            restored = ended?.ok ? ended.restored : undefined
          }
        })()
        // After --act: whether the panel's atoms were put back once the capture ended.
        return 'png' in shot && acts ? { ...shot, restored: restored === true } : shot
      })
    }
  }
}
