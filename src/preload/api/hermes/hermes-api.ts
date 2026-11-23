import type { HermesLaunchProfileRequest, HermesLaunchProfiles } from '../../../shared/hermes/hermes-launch-profiles'

/** The desktop's hosts: its own install, WSL distro homes and SSH hosts' `$HOME/.hermes`. */
export type HermesApi = {
  launchProfiles: (args?: HermesLaunchProfileRequest) => Promise<HermesLaunchProfiles | null>
}
