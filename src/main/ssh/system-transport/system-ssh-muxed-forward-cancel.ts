/** A mux forward remains on its master after the client exits; only the master can release it. */
import { runProcess } from '@orca/process-host'
import { buildSshArgs, type SystemSshBuildArgsOptions } from './system-ssh-args'
import { findSystemSsh } from './system-ssh-binary'
import type { SshTarget } from '../../../shared/ssh-types'

const SYSTEM_SSH_MUXED_FORWARD_CANCEL_TIMEOUT_MS = 5_000

/** Query the socket used by this target's commands. */
export function buildControlPathQueryArgs(
  target: SshTarget,
  options?: SystemSshBuildArgsOptions
): string[] {
  return ['-G', ...buildSshArgs(target, options)]
}

export function parseControlPath(stdout: string): string | null {
  const path = /^controlpath (.+)$/im.exec(stdout)?.[1]?.trim()
  return path && path.toLowerCase() !== 'none' ? path : null
}

/** Read no config: -O cancel also cancels its configured forwards, which may belong to the user. */
export function buildMuxedLocalForwardCancelArgs(
  controlPath: string,
  localPort: number,
  remoteHost: string,
  remotePort: number
): string[] {
  return [
    '-F',
    '/dev/null',
    // Why -S, not -o: an -o value is split on spaces. Doubled: ssh expands `%` tokens in it again.
    '-S',
    controlPath.replaceAll('%', '%%'),
    '-O',
    'cancel',
    '-L',
    `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`,
    '--',
    'orca-muxed-forward-cancel'
  ]
}

/** A refused `-O cancel` still exits 0, reporting `master cancel forward request failed`. */
function refusedMuxedForwardCancel(stderr: string): boolean {
  return stderr.includes('request failed')
}

async function runSsh(sshPath: string, args: string[]) {
  return runProcess({
    program: sshPath,
    args,
    timeoutMs: SYSTEM_SSH_MUXED_FORWARD_CANCEL_TIMEOUT_MS
  }).catch(() => null)
}

/** True only when the target master releases the exact forward specification. */
export async function cancelMuxedLocalForward(
  target: SshTarget,
  localPort: number,
  remoteHost: string,
  remotePort: number,
  options?: SystemSshBuildArgsOptions
): Promise<boolean> {
  // Why: Win32-OpenSSH has no multiplexing, so no master there can hold the port.
  const sshPath = process.platform === 'win32' ? null : findSystemSsh()
  if (!sshPath) {
    return false
  }
  const query = await runSsh(sshPath, buildControlPathQueryArgs(target, options))
  const controlPath = query?.code === 0 ? parseControlPath(query.stdout) : null
  if (!controlPath) {
    return false
  }
  const result = await runSsh(
    sshPath,
    buildMuxedLocalForwardCancelArgs(controlPath, localPort, remoteHost, remotePort)
  )
  if (result?.code !== 0 || refusedMuxedForwardCancel(result.stderr)) {
    return false
  }
  console.warn(
    `[ssh] Cancelled a forward a previous Orca left on 127.0.0.1:${localPort}, held by its ControlMaster`
  )
  return true
}
