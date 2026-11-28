import { ipcMain } from 'electron'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'

const BROWSER_SESSION_PROFILE_IPC_CHANNELS = [
  'browser:session:listProfiles',
  'browser:session:createProfile',
  'browser:session:ensureManagedProfile',
  'browser:identity:get',
  'browser:identity:set',
  'browser:session:deleteProfile',
  'browser:session:importCookies',
  'browser:session:resolvePartition',
  'browser:sitePermissions:list',
  'browser:sitePermissions:set',
  'browser:session:googleCookieClearTarget',
  'browser:session:clearGoogleCookies',
  'browser:session:importFromBrowserForClientHost',
  'browser:session:importCookiesForClientHost',
  'browser:session:clientRouteImportSources',
  'browser:session:clearCookies',
  'browser:session:clearCookiesForClientHost',
  'browser:session:clearCookiesForSshHost',
  'browser:session:detectBrowsers',
  'browser:session:detectBrowsersForClientHost',
  'browser:session:importFromBrowser'
] as const

export function registerLazyBrowserSessionProfileHandlers(): void {
  for (const channel of BROWSER_SESSION_PROFILE_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  registerLazyIpcHandleGroup(BROWSER_SESSION_PROFILE_IPC_CHANNELS, async (ipc) => {
    const { registerBrowserSessionProfileHandlers } = await import('./browser-session-profile-ipc')
    registerBrowserSessionProfileHandlers(ipc)
  })
}
