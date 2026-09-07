/**
 * The doctor's read on whether the daemon's socket path fits under the configured data root.
 *
 * A finding rather than a `Probe`: there is no uncertainty to represent. Nothing is read, so
 * there is no "unavailable" case, nothing for live evidence to supersede, and no reading that
 * could be stale. It is the platform's `sun_path` limit against a path the unit file names.
 *
 * Critical only when the definition supplies the root, which keeps the severity boundary
 * intact: `critical` means "this configuration will destroy running terminals", and only a
 * file that pins a root can say that about the service. Falling back to the calling shell's
 * root answers a different question — what would happen if you started orcad here — and is
 * reported as a warning that says so.
 */
import {
  checkDaemonSocketPathBudget,
  DAEMON_SOCKET_PATH_REMEDY,
  describeDaemonSocketPathOverflow
} from '../daemon/daemon-runtime-paths'
import type { SupervisorFinding } from '../../shared/supervisor-service-audit'
import {
  readPinnedUserData,
  type SupervisorServiceFile
} from '../../shared/supervisor-service-file-read'

export function auditDaemonSocketPathBudget(
  file: SupervisorServiceFile | undefined,
  expectedUserDataPath: string
): SupervisorFinding {
  const pinned = file ? readPinnedUserData(file) : null
  const userDataPath = pinned ?? expectedUserDataPath
  const budget = checkDaemonSocketPathBudget(userDataPath)
  if (budget.fits) {
    return {
      code: 'daemon_socket_path_fits',
      severity: 'ok',
      message: `The terminal daemon's socket path fits (${budget.bytes} of ${budget.limit} bytes).`
    }
  }
  const overflow = describeDaemonSocketPathOverflow(budget)
  return pinned === null
    ? {
        code: 'daemon_socket_path_too_long_here',
        severity: 'warning',
        // Says whose root it measured: reported against an installed service, this reads as a
        // verdict about that service unless it states otherwise.
        message: `${overflow} This is the root this shell resolves (${userDataPath}), not one a service definition pins.`,
        remedy: DAEMON_SOCKET_PATH_REMEDY
      }
    : {
        code: 'daemon_socket_path_too_long',
        severity: 'critical',
        message: overflow,
        remedy: DAEMON_SOCKET_PATH_REMEDY
      }
}
