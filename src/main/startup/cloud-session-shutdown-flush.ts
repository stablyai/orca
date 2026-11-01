import { powerMonitor } from 'electron'
import { flushUnsavedCloudSessions } from '../orca-profiles/profile-cloud-session-owner'

// OS shutdown may skip before-quit and lose rotated tokens; Windows reports session-end per window.
export function installCloudSessionShutdownFlush(): void {
  powerMonitor.on('shutdown', flushUnsavedCloudSessions)
}
