import { ipcRenderer } from 'electron'
import type { GhosttyImportPreview, GhosttyImportSource } from '../../shared/global-settings-types'
import type {
  WarpThemeImportPreview,
  WarpThemeImportSource
} from '../../shared/terminal-custom-themes'
import type { PreloadApi } from '../api-types'

export const settingsApi = {
  get: () => ipcRenderer.invoke('settings:get'),

  // Why: blocking read for the few startup decisions (terminal side-effect authority) that can't wait for async hydration. Call sparingly.
  getSync: () => ipcRenderer.sendSync('settings:get-sync'),

  set: (args: Record<string, unknown>) => ipcRenderer.invoke('settings:set', args),

  setActiveRuntimeEnvironmentPreference: (args: { environmentId: string | null }) =>
    ipcRenderer.invoke('settings:set-active-runtime-environment-preference', args),

  updatePRBotAuthorOverride: (args: { author: string; isBot: boolean }) =>
    ipcRenderer.invoke('settings:update-pr-bot-author-override', args),

  listFonts: (): Promise<string[]> => ipcRenderer.invoke('settings:listFonts'),

  previewGhosttyImport: (source?: GhosttyImportSource): Promise<GhosttyImportPreview> =>
    ipcRenderer.invoke('settings:previewGhosttyImport', source),

  previewWarpThemeImport: (source: WarpThemeImportSource): Promise<WarpThemeImportPreview> =>
    ipcRenderer.invoke('settings:previewWarpThemeImport', source),

  onChanged: (callback: (updates: Record<string, unknown>) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, updates: Record<string, unknown>): void =>
      callback(updates)
    ipcRenderer.on('settings:changed', listener)
    return () => ipcRenderer.removeListener('settings:changed', listener)
  }
} satisfies PreloadApi['settings']
