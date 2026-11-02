import type { HostProfile } from '../transport/types'

export type HostStoredDescriptor = {
  personalName?: string
  lastKnownMachineName?: string
  lastKnownHostPlatform?: NodeJS.Platform
}

export function storedHostDescriptor(host: HostProfile): HostStoredDescriptor {
  return {
    ...(host.personalName !== undefined ? { personalName: host.personalName } : {}),
    ...(host.lastKnownMachineName !== undefined
      ? { lastKnownMachineName: host.lastKnownMachineName }
      : {}),
    ...(host.lastKnownHostPlatform !== undefined
      ? { lastKnownHostPlatform: host.lastKnownHostPlatform }
      : {})
  }
}
