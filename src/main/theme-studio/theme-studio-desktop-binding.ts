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
import type { Store } from '../persistence/loading-store/store'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getUserPluginsDir } from '../plugins/plugin-discovery'
import { readPluginLockfile } from '../plugins/installation/plugin-install-lockfile-store'
import { ThemeStudioSession } from './theme-studio-session'
import { createThemeStudioService, type ThemeStudioWindow } from './theme-studio-service'

const REQUEST_TIMEOUT_MS = 10_000

/** The settings a saved theme replaces, and that picking another theme changes. */
const THEME_SLOT_KEYS = [
  'theme',
  'pluginAppThemeLight',
  'pluginAppThemeDark',
  'pluginIconTheme',
  'terminalThemeDark',
  'terminalThemeLight',
  'terminalUseSeparateLightTheme',
  'terminalColorOverrides',
  'terminalColorOverridesLight',
  'terminalPluginPalettes'
] as const satisfies readonly (keyof GlobalSettings)[]

function pickThemeSlots(settings: GlobalSettings): Partial<GlobalSettings> {
  // Why null for unset plugin choices: an absent key would not clear what the saved theme set.
  return {
    theme: settings.theme,
    pluginAppThemeLight: settings.pluginAppThemeLight ?? null,
    pluginAppThemeDark: settings.pluginAppThemeDark ?? null,
    pluginIconTheme: settings.pluginIconTheme ?? null,
    terminalThemeDark: settings.terminalThemeDark,
    terminalThemeLight: settings.terminalThemeLight,
    terminalUseSeparateLightTheme: settings.terminalUseSeparateLightTheme,
    terminalColorOverrides: settings.terminalColorOverrides,
    terminalColorOverridesLight: settings.terminalColorOverridesLight,
    terminalPluginPalettes: settings.terminalPluginPalettes ?? []
  }
}

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
  store: Pick<Store, 'getSettings' | 'updateSettings' | 'onSettingsChanged'>
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
    installedFrom: async (pluginKey) => {
      const source = (await readPluginLockfile(getUserPluginsDir(options.userDataPath))).plugins[
        pluginKey
      ]?.source
      return source ? (source.kind === 'local-path' ? source.path : pluginKey) : null
    },
    installFolder: installHostWrittenPluginFolder,
    // Why default on: the setting is new, so a profile that never saw it allows edits.
    agentEditsAllowed: () => options.store.getSettings().allowAgentThemeEdits !== false,
    slots: {
      snapshot: () => pickThemeSlots(options.store.getSettings()),
      restore: (previous) => {
        options.store.updateSettings(previous, { notifyListeners: true })
      }
    },
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
    if (fromMainWindow(event.sender) && parsed.success) {
      void service.actFromWindow(parsed.data.action, parsed.data.revision)
    }
  })
  options.store.onSettingsChanged((updates) => {
    const slots = THEME_SLOT_KEYS.some((key) => key in updates)
    const agentEditsOff = updates.allowAgentThemeEdits === false
    if (slots || agentEditsOff) {
      void service.settingsChanged({ slots, agentEditsOff })
    }
  })
  ipcMain.handle(THEME_STUDIO_CURRENT_CHANNEL, (event) =>
    fromMainWindow(event.sender) ? session.preview() : null
  )
  setThemeStudioForRpc(service)
}
