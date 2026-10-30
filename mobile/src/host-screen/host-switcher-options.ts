import { hostPickerOptions } from '../components/use-connected-host-picker'
import {
  selectConnectableHostProfiles,
  sortHostsByLastConnected
} from '../transport/host-catalog-selection'
import type { ConnectionState, HostCatalogEntry, HostProfile } from '../transport/types'

export type HostSwitcherOption = {
  value: string
  label: string
  subtitle: string
  state: ConnectionState
}

/** Desktops the header can switch to, most recently connected first. */
export function hostSwitcherHosts(catalog: readonly HostCatalogEntry[]): HostProfile[] {
  return sortHostsByLastConnected(selectConnectableHostProfiles(catalog))
}

export function hostSwitcherOptions(
  hosts: readonly HostProfile[],
  stateOf: (hostId: string) => ConnectionState
): HostSwitcherOption[] {
  return hostPickerOptions([...hosts]).map((option) => ({
    ...option,
    state: stateOf(option.value)
  }))
}
