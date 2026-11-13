import { ipcRenderer } from 'electron'

import type { HermesProfilesSnapshot } from '../../shared/hermes-profiles'

export const hermesProfilesApi = {
  list: (): Promise<HermesProfilesSnapshot> => ipcRenderer.invoke('hermesProfiles:list')
}
