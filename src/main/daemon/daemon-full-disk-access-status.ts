import type { DeveloperPermissionStatus } from '../../shared/developer-permissions-types'
import { getCurrentDaemonAdapter, getLegacyDaemonAdapters } from './daemon-provider-routing'
import { getDaemonProvider } from './daemon-provider-state'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import { getMacosFullDiskAccessStatus } from '../macos-full-disk-access-status'

/** macOS only; the caller gates it. A denied generation wins; granted needs every generation. */
export async function getTerminalHostsFullDiskAccessStatus(): Promise<DeveloperPermissionStatus> {
  const provider = getDaemonProvider()
  if (!provider) {
    return 'unknown'
  }
  const probes = [getCurrentDaemonAdapter(provider), ...getLegacyDaemonAdapters(provider)].map(
    (adapter) => adapter.getFullDiskAccessStatus()
  )
  if (provider instanceof DegradedDaemonPtyProvider) {
    probes.push(getMacosFullDiskAccessStatus())
  }
  const statuses = await Promise.all(probes)
  return statuses.includes('denied')
    ? 'denied'
    : statuses.every((status) => status === 'granted')
      ? 'granted'
      : 'unknown'
}
