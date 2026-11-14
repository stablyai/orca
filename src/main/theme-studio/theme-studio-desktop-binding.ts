import { join } from 'node:path'
import { ipcMain, type BrowserWindow, type WebContents } from 'electron'
import {
  THEME_STUDIO_CURRENT_CHANNEL,
  THEME_STUDIO_PREVIEW_CHANNEL,
  THEME_STUDIO_REPLY_CHANNEL,
  THEME_STUDIO_REPORT_CHANNEL,
  THEME_STUDIO_REQUEST_CHANNEL,
  THEME_STUDIO_USER_ACTION_CHANNEL,
  themeStudioReplySchema,
  themeStudioReportSchema,
  themeStudioUserActionSchema,
  type ThemeStudioReply,
  type ThemeStudioRequestBody
} from '../../shared/theme-studio/theme-studio-protocol'
import { setThemeStudioForRpc } from '../runtime/rpc/methods/theme-studio/theme-studio'
import { installHostWrittenPluginFolder } from '../runtime/rpc/methods/plugins/plugin-install-methods'
import { requestFromRenderer } from '../ipc/renderer-request-relay'
import { captureOrcaChrome } from '../plugins/view/plugin-view-chrome-shot'
import { isPluginShotWindowShown } from '../plugins/view/plugin-shot-policy'
import type { PluginService } from '../plugins/plugin-service'
import { ThemeStudioSession } from './theme-studio-session'
import { createThemeStudioService, type ThemeStudioWindow } from './theme-studio-service'

const REQUEST_TIMEOUT_MS = 10_000

const THEME_STUDIO_CHANNELS = {
  request: THEME_STUDIO_REQUEST_CHANNEL,
  reply: THEME_STUDIO_REPLY_CHANNEL,
  parseReply: (raw: unknown): ThemeStudioReply | null => {
    const parsed = themeStudioReplySchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  }
}

async function ask(
  contents: WebContents,
  body: ThemeStudioRequestBody
): Promise<Extract<ThemeStudioReply, { ok: true }>> {
  const reply = await requestFromRenderer(contents, THEME_STUDIO_CHANNELS, body, REQUEST_TIMEOUT_MS)
  if (!reply.ok) {
    throw new Error(reply.message)
  }
  return reply
}

/** `orca theme` for the desktop app: drafts paint in the main window; a headless serve refuses. */
export function bindThemeStudio(options: {
  serveMode: boolean
  userDataPath: string
  pluginService: PluginService
  getMainWindow: () => BrowserWindow | null
}): void {
  if (options.serveMode) {
    setThemeStudioForRpc(null)
    return
  }
  const contents = (): WebContents | null => {
    const window = options.getMainWindow()
    return window && !window.isDestroyed() ? window.webContents : null
  }
  const root = join(options.userDataPath, 'theme-studio')
  const session = new ThemeStudioSession({
    sessionFile: join(root, 'session.json'),
    push: (preview) => contents()?.send(THEME_STUDIO_PREVIEW_CHANNEL, preview)
  })
  const window = (): ThemeStudioWindow | null => {
    const target = contents()
    const mainWindow = options.getMainWindow()
    if (!target || !mainWindow) {
      return null
    }
    return {
      resolve: async () => {
        const reply = await ask(target, { kind: 'resolve' })
        if (!reply.resolved) {
          throw new Error('Orca did not report its colors.')
        }
        return reply.resolved
      },
      select: async (pluginKey) =>
        (await ask(target, { kind: 'select', pluginKey })).selected === true,
      capture: (mode) =>
        captureOrcaChrome(target, isPluginShotWindowShown(mainWindow), {
          region: 'window',
          ...(mode ? { colorScheme: mode } : {})
        })
    }
  }
  const service = createThemeStudioService({
    session,
    window,
    installedThemes: async () => {
      await options.pluginService.whenReady()
      const { contentPacks } = options.pluginService
      return {
        themes: contentPacks.themes.list(),
        terminalThemes: contentPacks.terminalThemes.list()
      }
    },
    installFolder: installHostWrittenPluginFolder,
    pluginsRoot: join(root, 'plugins')
  })
  const fromMainWindow = (sender: WebContents): boolean => sender === contents()
  ipcMain.on(THEME_STUDIO_REPORT_CHANNEL, (event, raw: unknown) => {
    const parsed = themeStudioReportSchema.safeParse(raw)
    if (fromMainWindow(event.sender) && parsed.success) {
      session.receiveReport(parsed.data)
    }
  })
  ipcMain.on(THEME_STUDIO_USER_ACTION_CHANNEL, (event, raw: unknown) => {
    const parsed = themeStudioUserActionSchema.safeParse(raw)
    // Why the revision: a click on a toast for an older draft must not keep or drop a newer one.
    if (
      !fromMainWindow(event.sender) ||
      !parsed.success ||
      parsed.data.revision !== session.currentRevision
    ) {
      return
    }
    if (parsed.data.action === 'discard') {
      session.end()
      return
    }
    void service.apply(undefined).catch((error) => {
      console.warn('[theme-studio] could not keep the draft:', error)
    })
  })
  ipcMain.handle(THEME_STUDIO_CURRENT_CHANNEL, (event) => {
    const draft = session.draft
    return fromMainWindow(event.sender) && draft
      ? { revision: session.currentRevision, draft }
      : null
  })
  setThemeStudioForRpc(service)
  void session.load()
}
