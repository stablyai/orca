/**
 * Is the orcad a Windows slot launched still running? LIVE / DEAD / UNKNOWN, as on POSIX.
 *
 * A PID is not an identity on Windows, so the launcher's record pairs it with the process
 * creation time and liveness needs both: the PID must be running (libuv's kill(pid, 0), which
 * opens the process and reads its exit code) and the slot's process-tree addon must report the
 * same creation time. A running PID with another creation time is a reused PID, so the recorded
 * process is gone. Anything the host cannot answer is UNKNOWN, never DEAD. The rules live in the
 * host script's `liveness` op.
 */
import { orcadWindowsBaseDir, orcadWindowsHostOpCommand } from './orcad-remote-windows-node'
import type { RemoteHostPlatform } from './ssh-remote-platform'

export function windowsOrcadLivenessProbeCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string
): string {
  return orcadWindowsHostOpCommand(host, orcadWindowsBaseDir(host, remoteInstallDir), 'liveness', [
    remoteInstallDir
  ])
}
