import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import { readRelayAuthContext } from './relay-auth-context'
import { createRelayRegionPreferenceReader } from './relay-region-preference-reader'
import { selfHostedRelayAuthContext, type SelfHostedRelayConfig } from './self-hosted-relay-config'

export type DesktopRelayAuthOptions = {
  authConfig?: OrcaCloudAuthConfig
  selfHosted?: SelfHostedRelayConfig
  userDataPath: string
}

export function createDesktopRelayAuthOptions(options: DesktopRelayAuthOptions) {
  const authConfig = options.selfHosted ?? options.authConfig
  if (!authConfig) {
    throw new Error('relay_not_configured')
  }
  const regionPreference = options.selfHosted
    ? undefined
    : createRelayRegionPreferenceReader({ authConfig, userDataPath: options.userDataPath })
  return {
    readContext: async () =>
      options.selfHosted
        ? selfHostedRelayAuthContext(options.selfHosted)
        : options.authConfig
          ? await readRelayAuthContext(options.authConfig, options.userDataPath)
          : null,
    brokerOptions: {
      authConfig,
      resolvePreferredRegion: regionPreference?.resolvePreferredRegion,
      measureRegionDecision: regionPreference?.measureRegionDecision,
      onAssignedCellActive: regionPreference?.noteAssignedCell
    }
  }
}
