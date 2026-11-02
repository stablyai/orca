import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { WebContents } from 'electron'
import type {
  PluginViewColorScheme,
  PluginViewReply
} from '../../../shared/plugins/view/plugin-view-protocol'
import {
  pluginEditorActInputEvents,
  type PluginEditorShotAct
} from '../../../shared/plugins/view/plugin-editor-shot-acts'
import { PluginCliError } from '../../../shared/plugins/approval/plugin-cli-approval'
import {
  capturePluginPanelPng,
  settlePluginFrameGuest,
  withPaintingWhileHidden
} from './plugin-view-capture'
import { requestPluginViewFromRenderer } from './plugin-view-renderer-relay'
import { PLUGIN_SHOT_ACT_WINDOW_SHOWN_MESSAGE, pluginShotThemeDecision } from './plugin-shot-policy'
import { resolvePluginViewEditor } from './plugin-view-target'
import type { PluginViewDesktopDeps } from './plugin-view-desktop'

export type PluginEditorShotResult = {
  pluginKey: string
  editorId: string
  title: string
  filePath: string
  /** Base64 PNG, one pixel per window point. */
  png: string
  width: number
  height: number
  colorScheme: PluginViewColorScheme
  themeApplied: boolean
  themeReason?: string
  /** The editor got its document before the capture. */
  settled: boolean
  /** It asked for its document within 5 s; false fails the CLI. */
  subscribed: boolean
  /** What it threw or logged as errors (content-policy blocks included) during the capture. */
  errors: string[]
  /** How many `acts` were sent. */
  acted?: number
  /** The acts ran on a temporary copy, so the file itself was never changed. */
  copy?: true
}

/** What `plugins.open --editor` sends the renderer to find, or else open, the file's workspace. */
export async function pluginEditorFileTarget(
  filePath: string
): Promise<{ filePathAliases?: string[]; fallbackFolder: string }> {
  // Why the real path too: `/tmp` and `/private/tmp` are one folder on macOS.
  const real = await realpath(filePath).catch(() => null)
  return {
    ...(real && real !== filePath ? { filePathAliases: [real] } : {}),
    fallbackFolder: dirname(real ?? filePath)
  }
}

const RENDER_TIMEOUT_MS = 15_000
const REPLY_GRACE_MS = 10_000
const OPEN_TIMEOUT_MS = 10_000
const MAX_ERRORS = 20

/** Sends each act's input to the guest, or to the window's page at the frame's place, and lets
 *  the editor paint what it did before the next one. */
async function runEditorActs(
  acts: readonly PluginEditorShotAct[],
  target: { contents: WebContents; origin: { x: number; y: number }; scale: number },
  guest: WebContents | undefined
): Promise<void> {
  for (const act of acts) {
    for (const event of pluginEditorActInputEvents(act, target.origin, target.scale)) {
      target.contents.sendInputEvent(event)
    }
    await settlePluginFrameGuest(guest ?? target.contents)
  }
}

export async function shootPluginEditor(
  deps: PluginViewDesktopDeps,
  contents: WebContents,
  params: {
    pluginKey: string
    filePath: string
    colorScheme?: PluginViewColorScheme
    width?: number
    height?: number
    acts?: PluginEditorShotAct[]
    /** Act on the file itself instead of a copy. */
    inPlace?: boolean
  }
): Promise<PluginEditorShotResult> {
  const { pluginKey, filePath, acts } = params
  const editor = await resolvePluginViewEditor(deps.source, pluginKey, filePath)
  if (acts && deps.windowShown()) {
    throw new PluginCliError('invalid_argument', PLUGIN_SHOT_ACT_WINDOW_SHOWN_MESSAGE, {
      reason: 'window_shown',
      nextSteps: ['Minimize or hide Orca, then run this again.']
    })
  }
  const { colorScheme, themeReason } = pluginShotThemeDecision(
    params.colorScheme,
    deps.windowShown()
  )
  const { cursor } = deps.logsSince(pluginKey)
  // Why a copy: acts are real input, and a shot must never change the author's file.
  const scratchDir =
    acts && !params.inPlace
      ? await mkdtemp(join(deps.shotScratchRoot?.() ?? tmpdir(), 'orca-editor-shot-'))
      : null
  const shotPath = scratchDir ? join(scratchDir, basename(filePath)) : filePath
  return withPaintingWhileHidden([contents, ...deps.guestsOf(pluginKey)], async () => {
    let wokeGuest: WebContents | undefined
    try {
      if (scratchDir) {
        await copyFile(filePath, shotPath)
      }
      const reply: PluginViewReply = await requestPluginViewFromRenderer(
        contents,
        {
          kind: 'open-editor',
          pluginKey,
          editorId: editor.editorId,
          filePath: shotPath,
          ...(await pluginEditorFileTarget(shotPath)),
          capture: {
            ...(scratchDir ? { scratch: true as const } : {}),
            ...(colorScheme === undefined ? {} : { colorScheme }),
            ...(params.width === undefined ? {} : { width: params.width }),
            ...(params.height === undefined ? {} : { height: params.height }),
            timeoutMs: RENDER_TIMEOUT_MS
          }
        },
        RENDER_TIMEOUT_MS + REPLY_GRACE_MS
      )
      if (!reply.ok) {
        throw new PluginCliError('invalid_argument', reply.message, {
          reason: reply.code,
          nextSteps: [
            `\`orca plugin logs ${pluginKey}\` shows what the editor reported; fix it, then shoot again.`
          ]
        })
      }
      const drawn = reply.panel
      if (!drawn) {
        throw new Error('Orca did not report where the editor is drawn.')
      }
      // The guest isolates its own page, so its painting is kept awake here too.
      const guest = drawn.guestUrl
        ? deps.guestsOf(pluginKey).find((each) => each.getURL() === drawn.guestUrl)
        : undefined
      if (guest?.getBackgroundThrottling()) {
        guest.setBackgroundThrottling(false)
        wokeGuest = guest
      }
      await settlePluginFrameGuest(guest)
      if (acts) {
        await runEditorActs(
          acts,
          guest
            ? { contents: guest, origin: { x: 0, y: 0 }, scale: 1 }
            : { contents, origin: drawn.rect, scale: contents.getZoomFactor() },
          guest
        )
      }
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
        editorId: editor.editorId,
        title: editor.title,
        filePath,
        png: image.png.toString('base64'),
        width: image.width,
        height: image.height,
        colorScheme: drawn.colorScheme,
        themeApplied: drawn.themeApplied,
        ...(themeReason ? { themeReason } : {}),
        settled: drawn.settled,
        subscribed: drawn.subscribed === true,
        errors: [...(drawn.issue ? [drawn.issue] : []), ...logged].slice(0, MAX_ERRORS),
        ...(acts ? { acted: acts.length } : {}),
        ...(scratchDir ? { copy: true as const } : {})
      }
    } finally {
      if (wokeGuest && !wokeGuest.isDestroyed()) {
        wokeGuest.setBackgroundThrottling(true)
      }
      // Puts back the theme and the editor's size, and closes what the shot opened.
      await requestPluginViewFromRenderer(contents, { kind: 'end-capture' }, OPEN_TIMEOUT_MS).catch(
        () => null
      )
      if (scratchDir) {
        await rm(scratchDir, { recursive: true, force: true })
      }
    }
  })
}
