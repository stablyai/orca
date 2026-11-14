import type { HostProfile } from '../../host-catalog/host-profile'
import type { HostMachine } from '../../../../src/shared/host-machine-line'

export type HostStoredDescriptor = {
  personalName?: string
  lastKnownMachineName?: string
  lastKnownHostPlatform?: NodeJS.Platform
  lastKnownHostMachine?: HostMachine
}

export function storedHostDescriptor(host: HostProfile): HostStoredDescriptor {
  return {
    ...(host.personalName !== undefined ? { personalName: host.personalName } : {}),
    ...(host.lastKnownMachineName !== undefined
      ? { lastKnownMachineName: host.lastKnownMachineName }
      : {}),
    ...(host.lastKnownHostPlatform !== undefined
      ? { lastKnownHostPlatform: host.lastKnownHostPlatform }
      : {}),
    ...(host.lastKnownHostMachine !== undefined
      ? { lastKnownHostMachine: host.lastKnownHostMachine }
      : {})
  }
}
