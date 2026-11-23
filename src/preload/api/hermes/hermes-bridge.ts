import { ipcRenderer } from 'electron'
import type {
  HermesLaunchProfileRequest,
  HermesLaunchProfiles
} from '../../../shared/hermes/hermes-launch-profiles'
import type { PreloadApi } from '../../api-types'

export const hermesApi = {
  /** Named Hermes profiles for the pane's host, for the quick-launch profile submenu; null when unknown. */
  launchProfiles: (args?: HermesLaunchProfileRequest): Promise<HermesLaunchProfiles | null> =>
    ipcRenderer.invoke('hermes:launchProfiles', args ?? {})
} satisfies PreloadApi['hermes']
