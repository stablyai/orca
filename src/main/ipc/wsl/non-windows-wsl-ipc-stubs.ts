import { ipcMain } from 'electron'

const NON_WINDOWS_EMPTY_ARRAY_CHANNELS = [
  'wslMove:listPendingRendererRewrites',
  'wslMove:listUnfinished',
  'wslMoveOrchestrator:list',
  'wslDriveUnc:lastOutcomes',
  'wslDriveUnc:listPendingRendererRewrites'
] as const

const NON_WINDOWS_FALSE_CHANNELS = ['wslMove:isRunning', 'wslMove:cancel'] as const
const NON_WINDOWS_VOID_CHANNELS = [
  'wslMoveOrchestrator:projectOpened',
  'wslMoveOrchestrator:answerSleptPanes'
] as const

const NON_WINDOWS_ALL_CHANNELS = [
  ...NON_WINDOWS_EMPTY_ARRAY_CHANNELS,
  ...NON_WINDOWS_FALSE_CHANNELS,
  ...NON_WINDOWS_VOID_CHANNELS,
  'wslMove:recordStoreRewritten',
  'wslMove:preview',
  'wslMove:start',
  'wslMove:useProjectHereAgain',
  'wslMoveOrchestrator:userAction',
  'wslDriveProject:preview',
  'wslDriveProject:convert',
  'wslDriveUnc:convert',
  'wslDriveUnc:recordStoreRewritten'
] as const

/** Lightweight stubs for non-Windows launches so WSL move/drive modules stay out of Main boot. */
export function registerNonWindowsWslIpcStubs(): void {
  for (const channel of NON_WINDOWS_ALL_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  for (const channel of NON_WINDOWS_EMPTY_ARRAY_CHANNELS) {
    ipcMain.handle(channel, () => [])
  }
  for (const channel of NON_WINDOWS_FALSE_CHANNELS) {
    ipcMain.handle(channel, () => false)
  }
  for (const channel of NON_WINDOWS_VOID_CHANNELS) {
    ipcMain.handle(channel, () => undefined)
  }
  ipcMain.handle('wslMove:recordStoreRewritten', () => ({
    recorded: false,
    reason: 'unknown-store'
  }))
  ipcMain.handle('wslMove:preview', () => ({
    outcome: 'refused',
    code: 'wsl_move_unavailable'
  }))
  ipcMain.handle('wslMove:start', () => ({
    outcome: 'refused',
    code: 'wsl_move_unavailable'
  }))
  ipcMain.handle('wslMove:useProjectHereAgain', () => ({
    released: false,
    reason: 'gated-off'
  }))
  ipcMain.handle('wslMoveOrchestrator:userAction', () => null)
  ipcMain.handle('wslDriveProject:preview', () => {
    throw new Error('wsl_drive_project_unavailable')
  })
  ipcMain.handle('wslDriveProject:convert', () => {
    throw new Error('wsl_drive_project_unavailable')
  })
  ipcMain.handle('wslDriveUnc:convert', () => {
    throw new Error('wsl_drive_unc_unavailable')
  })
  ipcMain.handle('wslDriveUnc:recordStoreRewritten', () => ({
    recorded: false,
    reason: 'gated-off'
  }))
}
