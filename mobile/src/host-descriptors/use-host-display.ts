import {
  resolveHostDisplay,
  type HostDisplayResolution
} from '../../../src/shared/host-display-resolution'
import { useHostDescriptor } from './host-descriptor-store'
import { classifyLegacyHostName } from '../host-catalog/host-name-identity'
import type { HostMachine } from '../../../src/shared/host-machine-line'

export type HostDisplaySource = {
  id: string
  name: string
  personalName?: string
  lastKnownMachineName?: string
  lastKnownHostPlatform?: NodeJS.Platform
  lastKnownHostMachine?: HostMachine
}

// Live descriptors override persisted identity even when empty; the phone’s rename still wins the title.
// Pass null while loading; older shell labels retain their legacy classification.
export function useHostDisplay(host: HostDisplaySource | null): HostDisplayResolution {
  const live = useHostDescriptor(host?.id)
  // Why: a source without identity fields (a page handed its host by an older shell) holds a label.
  const identity = host ? classifyLegacyHostName(host) : null
  return resolveHostDisplay({
    name: identity?.personalName ?? live?.machineName ?? identity?.name ?? '',
    machineName: live ? live.machineName : (host?.lastKnownMachineName ?? null),
    platform: live ? live.platform : (host?.lastKnownHostPlatform ?? null),
    machine: live ? (live.machine ?? null) : (host?.lastKnownHostMachine ?? null)
  })
}
