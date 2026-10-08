/**
 * Stopping a Windows orcad: the slot's stop-request file, never a signal.
 *
 * `kill -TERM` and `process.kill(pid, 'SIGTERM')` are TerminateProcess on Windows, which skips
 * the durable shutdown and leaves the instance lock behind, so a build whose readiness does not
 * advertise `health.stopRequests` is refused rather than terminated. The host script's `stop` op
 * answers with the POSIX command's tokens, plus UNSUPPORTED.
 */
import { orcadWindowsBaseDir, orcadWindowsHostOpCommand } from './orcad-remote-windows-node'
import type { RemoteHostPlatform } from './ssh-remote-platform'

export function windowsStopOrcadCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  options: { waitSeconds: number; justLaunched: boolean }
): string {
  return orcadWindowsHostOpCommand(host, orcadWindowsBaseDir(host, remoteInstallDir), 'stop', [
    remoteInstallDir,
    String(options.waitSeconds),
    options.justLaunched ? '1' : '0'
  ])
}
