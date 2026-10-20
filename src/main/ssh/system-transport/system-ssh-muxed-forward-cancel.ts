/**
 * A forward made through a ControlMaster leaves its local listener on that master: the `-N` client
 * exits at once and the master keeps the port, long after the Orca that asked for it is gone. No
 * process of Orca's holds the port then, so the orphan sweep finds nothing to stop and a managed
 * tunnel's fixed port stays bound until the master is asked to drop that one forward.
 */
import { runProcess } from '@orca/process-host'
import { buildSshArgs, type SystemSshBuildArgsOptions } from './system-ssh-args'
import { findSystemSsh } from './system-ssh-binary'
import type { SshTarget } from '../../../shared/ssh-types'

export const SYSTEM_SSH_MUXED_FORWARD_CANCEL_TIMEOUT_MS = 5_000

/** Multiplexed on purpose: `-O` speaks to the control socket a forward's own `-S none` drops. */
export function buildMuxedLocalForwardCancelArgs(
  target: SshTarget,
  localPort: number,
  remoteHost: string,
  remotePort: number,
  options?: SystemSshBuildArgsOptions
): string[] {
  const args = buildSshArgs(target, options)
  const destinationIndex = args.lastIndexOf('--')
  const cancelArgs = ['-O', 'cancel', '-L', `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`]
  args.splice(destinationIndex === -1 ? 0 : destinationIndex, 0, ...cancelArgs)
  return args
}

/**
 * A refused `-O cancel` still exits 0, reporting `master cancel forward request failed` on stderr,
 * so a spec no master registered would otherwise read as a release that freed the port.
 */
function refusedMuxedForwardCancel(stderr: string): boolean {
  return stderr.includes('request failed')
}

/**
 * True when a master released this exact forward. OpenSSH refuses a spec no master registered, so
 * someone else's forward on this port, and a port held by anything but a master, are left alone.
 */
export async function cancelMuxedLocalForward(
  target: SshTarget,
  localPort: number,
  remoteHost: string,
  remotePort: number,
  options?: SystemSshBuildArgsOptions
): Promise<boolean> {
  const sshPath = findSystemSsh()
  if (!sshPath) {
    return false
  }
  const args = buildMuxedLocalForwardCancelArgs(target, localPort, remoteHost, remotePort, options)
  const result = await runProcess({
    program: sshPath,
    args,
    timeoutMs: SYSTEM_SSH_MUXED_FORWARD_CANCEL_TIMEOUT_MS
  }).catch(() => null)
  if (result?.code !== 0 || refusedMuxedForwardCancel(result.stderr)) {
    return false
  }
  console.warn(
    `[ssh] Cancelled a forward a previous Orca left on 127.0.0.1:${localPort}, held by its ControlMaster`
  )
  return true
}
