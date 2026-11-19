import { powerMonitor } from 'electron'
import { flushUnsavedOrcaCloudSessionsOnShutdown } from '../../orca-profiles/cloud-session/profile-cloud-session-store'

export function installCloudSessionShutdownFlush(): void {
  powerMonitor.on('shutdown', flushUnsavedOrcaCloudSessionsOnShutdown)
}
