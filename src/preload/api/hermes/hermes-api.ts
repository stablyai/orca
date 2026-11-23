import type { HermesLaunchProfiles } from '../../../shared/hermes/hermes-launch-profiles'

/** The desktop's local Hermes install; the web client has none. */
export type HermesApi = {
  launchProfiles: () => Promise<HermesLaunchProfiles>
}
