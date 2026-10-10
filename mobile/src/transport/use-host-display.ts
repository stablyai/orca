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

/**
 * The display precedence, stated once: a live-reported descriptor beats the persisted last-known
 * one — including a live reply that reported nothing, which is the desktop's own answer. The title
 * is the phone's override, else the live machine name, else the stored resolved `name`; the live
 * name leads only because the stored copy catches up on the next host-list load.
 * Pass null while the host record is still loading.
 */
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
