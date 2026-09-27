import { ipcMain } from 'electron'
import type { SshReadinessReport } from '../../shared/ssh-types'
import type { SshConnectionManager } from '../ssh/ssh-connection-manager'
import { captureSshExecChannel } from '../ssh/ssh-exec-channel-capture'
import { parseSshReadiness, SSH_READINESS_PROBE_SCRIPT } from '../ssh/ssh-host-readiness'

const SSH_READINESS_TIMEOUT_MS = 20_000

/** The probe's own lines are what the report is made of, so 64 KiB is already far past a full report. */
const SSH_READINESS_STDOUT_LIMIT_BYTES = 64 * 1024

// Why: a check that failed is a finding, not an error — the probe exits 0 by design, and a host
// with no POSIX sh fails before it prints anything. Only transport loss and the timeout reject.
export function registerSshHostReadinessHandler(
  getConnectionManager: () => SshConnectionManager | null
): void {
  ipcMain.removeHandler('ssh:probeReadiness')

  ipcMain.handle(
    'ssh:probeReadiness',
    async (_event, args: { targetId: string }): Promise<SshReadinessReport> => {
      const mgr = getConnectionManager()
      if (!mgr) {
        throw new Error('SSH connection manager not initialized')
      }
      const conn = mgr.getConnection(args.targetId)
      if (!conn) {
        throw new Error(`SSH connection "${args.targetId}" not found`)
      }

      // Why: no exec options — conn.exec's default POSIX wrapping is what turns the probe's
      // newlines into one /bin/sh -c line (see wrapRemoteCommandForPosixShell), as browsing does.
      const { stdout } = await captureSshExecChannel(conn, SSH_READINESS_PROBE_SCRIPT, {
        timeoutMs: SSH_READINESS_TIMEOUT_MS,
        timeoutMessage: 'SSH host readiness probe timed out',
        stdoutByteLimit: SSH_READINESS_STDOUT_LIMIT_BYTES
      })
      return parseSshReadiness(stdout)
    }
  )
}
