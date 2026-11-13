import { wslHostsServing } from '../../wsl/host-lifecycle/wsl-host-gate'
import { readFakeWslHostsConfig } from '../../wsl/host-lifecycle/wsl-host-e2e-fake-connector'

export function canCreateWslHostService(): boolean {
  return (
    wslHostsServing() &&
    (process.platform === 'win32' ||
      (import.meta.env.MODE === 'e2e' && readFakeWslHostsConfig() !== null))
  )
}
