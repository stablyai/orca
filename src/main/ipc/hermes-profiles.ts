import { ipcMain } from 'electron'

import type { HermesProfilesSnapshot } from '../../shared/hermes-profiles'
import { listHermesProfiles } from '../hermes/hermes-profiles'

/** Local Hermes profiles for the launch menu; remote hosts keep the free-form Arguments field. */
export function registerHermesProfileHandlers(): void {
  ipcMain.removeHandler('hermesProfiles:list')
  ipcMain.handle('hermesProfiles:list', (): Promise<HermesProfilesSnapshot> => listHermesProfiles())
}
