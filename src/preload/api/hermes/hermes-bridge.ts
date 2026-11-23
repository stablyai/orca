import { ipcRenderer } from 'electron'
import type { HermesLaunchProfiles } from '../../../shared/hermes/hermes-launch-profiles'
import type { PreloadApi } from '../../api-types'

export const hermesApi = {
  /** Named Hermes profiles on this machine, for the quick-launch profile submenu. */
  launchProfiles: (): Promise<HermesLaunchProfiles> => ipcRenderer.invoke('hermes:launchProfiles')
} satisfies PreloadApi['hermes']
