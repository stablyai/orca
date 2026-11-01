import { app, BrowserWindow, dialog, shell, webContents } from 'electron'
import { writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { normalizeBrowserDownloadFilename } from '../../../shared/browser-download-filename'
import { isPluginExternalUrl } from '../../../shared/plugins/workers/plugin-host-api'
import { createPanelMessageBudget } from '../../../shared/plugins/frames/plugin-panel-message-budget'
import type { PanelMessageBudget } from '../../../shared/plugins/frames/plugin-panel-message-budget'
import type { PluginDesktopFrameServices } from '../workers/plugin-host-method-bindings'
import { PluginHostCallError, type PluginHostCallScope } from '../workers/plugin-host-call-scope'
import { markPluginSavedFileAsDownloaded } from './plugin-save-as-download-mark'
import { confirmPluginExternalOpen } from './plugin-external-open-consent'
import type { Store } from '../../persistence/loading-store/store'
import { translateMain } from '../../i18n/main-i18n'
import { blockedPluginSaveAsExtension } from '../../../shared/plugins/frames/plugin-save-as-extensions'

/** Backstop behind the frame host's one-call-per-gesture check: a few dialogs or tabs at most. */
const DESKTOP_FRAME_RATE_LIMIT = {
  maxMessages: 3,
  perMs: 10_000,
  maxBytes: Number.MAX_SAFE_INTEGER
}

// Every main window that hosts plugin frames; a call is honoured only from one of them.
const hostWindows = new Set<BrowserWindow>()
const budgets = new Map<string, PanelMessageBudget>()
let services: PluginDesktopFrameServices | null = null

/** Null in headless serve and before a main window exists: the methods then fail. */
export function getPluginDesktopFrameServices(): PluginDesktopFrameServices | null {
  return services
}

/** The host window whose frame made the call; never a guess from focus. */
function callingWindow(scope: PluginHostCallScope): BrowserWindow {
  const sender =
    scope.callerWebContentsId === undefined
      ? undefined
      : webContents.fromId(scope.callerWebContentsId)
  const window = sender && !sender.isDestroyed() ? BrowserWindow.fromWebContents(sender) : null
  if (!window || window.isDestroyed() || !hostWindows.has(window)) {
    throw new PluginHostCallError('unavailable', 'the window that made this call is gone')
  }
  return window
}

function admit(window: BrowserWindow, pluginId: string): void {
  const key = `${window.id}\0${pluginId}`
  let budget = budgets.get(key)
  if (!budget) {
    budget = createPanelMessageBudget(DESKTOP_FRAME_RATE_LIMIT)
    budgets.set(key, budget)
  }
  const now = Date.now()
  if (budget.admit(now, 0)) {
    throw new PluginHostCallError(
      'rate_limited',
      'too many requests; try again shortly',
      budget.retryAfterMs?.(now)
    )
  }
}

export function installPluginDesktopFrameServices(
  window: BrowserWindow,
  store: Pick<Store, 'getSettings' | 'updateSettings'>
): void {
  hostWindows.add(window)
  window.once('closed', () => {
    hostWindows.delete(window)
    for (const key of budgets.keys()) {
      if (key.startsWith(`${window.id}\0`)) {
        budgets.delete(key)
      }
    }
  })
  if (services) {
    return
  }
  services = {
    async openExternal(pluginId, url, scope) {
      // Re-checked here: the shared schema already refused other schemes, but this is the sink.
      if (!isPluginExternalUrl(url)) {
        throw new Error('url must be an http:, https: or mailto: URL')
      }
      const window = callingWindow(scope)
      const pluginName = scope.pluginName ?? pluginId
      const consent = await confirmPluginExternalOpen({
        window,
        store,
        pluginId,
        pluginName,
        url,
        log: scope.log,
        admit: () => admit(window, pluginId)
      })
      if (consent !== 'allowed') {
        return {
          opened: false,
          reason: consent === 'cancelled' ? 'cancelled' : 'consent-unavailable'
        }
      }
      // The prompt may have stayed open while the plugin was disabled or removed.
      scope.assertActive()
      await shell.openExternal(url)
      return { opened: true }
    },
    async saveFile(pluginId, input, scope) {
      const parent = callingWindow(scope)
      admit(parent, pluginId)
      refuseBlockedExtension(input.suggestedName ?? '')
      const name = normalizeBrowserDownloadFilename(
        input.suggestedName ?? 'download',
        process.platform
      )
      const options: Electron.SaveDialogOptions = {
        title: translateMain('plugins.frameSaveAs.title', 'Save File'),
        defaultPath: join(app.getPath('downloads'), name),
        filters: saveDialogFilters(name)
      }
      const result = await dialog.showSaveDialog(parent, options)
      if (result.canceled || !result.filePath) {
        return false
      }
      // Re-checked: the person may type a name, but plugin data still never becomes a program.
      refuseBlockedExtension(result.filePath)
      // The dialog may have stayed open while the plugin was disabled or removed.
      scope.assertActive()
      const { data } = input
      await writeFile(result.filePath, data instanceof ArrayBuffer ? new Uint8Array(data) : data)
      await markPluginSavedFileAsDownloaded(result.filePath)
      return true
    }
  }
}

function refuseBlockedExtension(name: string): void {
  const blocked = blockedPluginSaveAsExtension(name)
  if (blocked) {
    throw new Error(`plugins cannot save .${blocked} files: they would run when opened`)
  }
}

/** Any MIME type is accepted; the filter only follows the suggested name's extension. */
export function saveDialogFilters(name: string): Electron.FileFilter[] | undefined {
  const extension = extname(name).slice(1)
  if (!/^[\w.+-]{1,32}$/.test(extension)) {
    return undefined
  }
  return [
    { name: extension.toUpperCase(), extensions: [extension] },
    { name: translateMain('plugins.frameSaveAs.allFiles', 'All Files'), extensions: ['*'] }
  ]
}
