import { powerMonitor } from 'electron'
import { flushUnsavedCloudSessions } from '../orca-profiles/profile-cloud-session-owner'

// Why: an OS shutdown can end the process without before-quit, losing a rotated token that is
// held only in memory. Windows reports it per window as session-end (see createMainWindow).
export function installCloudSessionShutdownFlush(): void {
  powerMonitor.on('shutdown', flushUnsavedCloudSessions)
}
