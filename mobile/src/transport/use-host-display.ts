import {
  resolveHostDisplay,
  type HostDisplayResolution
} from '../../../src/shared/host-display-resolution'
import { useHostDescriptor } from './host-descriptor-store'
import { classifyLegacyHostName } from './host-name-identity'

export type HostDisplaySource = {
  id: string
  name: string
  personalName?: string
  lastKnownMachineName?: string
  lastKnownHostPlatform?: NodeJS.Platform
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
    platform: live ? live.platform : (host?.lastKnownHostPlatform ?? null)
  })
}
