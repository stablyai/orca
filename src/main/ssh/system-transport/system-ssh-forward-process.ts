import type { ChildProcessHandle as ChildProcess } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import { connect } from 'node:net'
import { createSshOperationAbortError } from '../connection/ssh-exec-options'
import { buildForwardProcessSshArgs, type SystemSshBuildArgsOptions } from './system-ssh-args'
import { findSystemSsh } from './system-ssh-binary'
import { reserveLocalForwardPort } from './system-ssh-forward-port-reservation'
import type { SshTarget } from '../../../shared/ssh-types'

export const SYSTEM_SSH_FORWARD_STARTUP_GRACE_MS = 750
export const SYSTEM_SSH_FORWARD_LISTENER_PROBE_INTERVAL_MS = 50
export const SYSTEM_SSH_FORWARD_STOP_TIMEOUT_MS = 2_000
// Why short: SIGKILL is uncatchable, so a child that has not reported exit this long after it is
// either already reaped or beyond anything teardown can do about it.
export const SYSTEM_SSH_FORWARD_POST_KILL_TIMEOUT_MS = 500

type SystemSshPortForwardProcess = {
  process: ChildProcess
  /** The local port the forward listens on, chosen here when the caller asked for any (0). */
  localPort: number
  waitForStartup: () => Promise<void>
  close: () => Promise<void>
  dispose: () => void
}

export function spawnSystemSshPortForward(
  target: SshTarget,
  localPort: number,
  remoteHost: string,
  remotePort: number,
  options?: SystemSshBuildArgsOptions
): ChildProcess {
  const sshPath = findSystemSsh()
  if (!sshPath) {
    throw new Error(
      'No system ssh binary found. Install OpenSSH to use system SSH port forwarding.'
    )
  }
  const args = buildSystemSshPortForwardArgs(target, localPort, remoteHost, remotePort, options)
  // Why: port-forward ssh processes are not wired to Orca credential prompts;
  // system SSH forwards must authenticate via OpenSSH config, agent, or control socket.
  return spawnProcess({
    program: sshPath,
    args,
    stdio: ['ignore', 'ignore', 'pipe']
  })
}

export function buildSystemSshPortForwardArgs(
  target: SshTarget,
  localPort: number,
  remoteHost: string,
  remotePort: number,
  options?: SystemSshBuildArgsOptions
): string[] {
  const args = buildForwardProcessSshArgs(target, options)
  const destinationIndex = args.lastIndexOf('--')
  // Why `no`: this second login re-reads the host's ssh_config, so a LocalForward/RemoteForward
  // there collides with the one Orca's main connection already holds, and `yes` exits on it.
  // ClearAllForwardings would also drop this -L; stopOnOwnListenFailure checks ours instead.
  const forwardArgs = [
    '-N',
    '-o',
    'ExitOnForwardFailure=no',
    '-L',
    `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`
  ]
  if (destinationIndex === -1) {
    args.unshift(...forwardArgs)
  } else {
    // Why: OpenSSH parses options only before `--`; after it, args are the
    // destination and optional remote command.
    args.splice(destinationIndex, 0, ...forwardArgs)
  }
  return args
}

/**
 * An `ssh -N` forward, already listening on the port it reports. Never asks a ControlMaster to
 * cancel a forward: any fixed port reaches here, so that is the managed tunnel's call alone.
 */
export function startSystemSshPortForwardProcess(
  target: SshTarget,
  localPort: number,
  remoteHost: string,
  remotePort: number,
  options?: SystemSshBuildArgsOptions,
  signal?: AbortSignal
): Promise<SystemSshPortForwardProcess> {
  signal?.throwIfAborted()
  const orphanArgs =
    localPort === 0
      ? undefined
      : buildSystemSshPortForwardArgs(target, localPort, remoteHost, remotePort, options)
  return reserveLocalForwardPort(localPort, orphanArgs).then((boundPort) => {
    signal?.throwIfAborted()
    const process = spawnSystemSshPortForward(target, boundPort, remoteHost, remotePort, options)
    stopOnOwnListenFailure(process, boundPort)
    return {
      process,
      localPort: boundPort,
      waitForStartup: () => waitForSystemSshForwardStartup(process, boundPort),
      close: () => waitForSystemSshForwardStop(process),
      dispose: () => {
        try {
          process.kill('SIGTERM')
        } catch {
          /* best-effort teardown */
        }
      }
    }
  })
}

/** OpenSSH's report that it could not listen on `localPort`, as opposed to an ssh_config forward. */
function ownListenFailureLine(stderr: string, localPort: number): string | null {
  return (
    new RegExp(`^.*cannot listen to port: ${localPort}(?=\\r?\\n)`, 'm').exec(stderr)?.[0] ?? null
  )
}

/** Without ExitOnForwardFailure, ssh outlives a failed bind of our own listener; end it then. */
function stopOnOwnListenFailure(process: ChildProcess, localPort: number): void {
  let tail = ''
  const stop = (): void => {
    process.stderr?.off('data', onStderr)
  }
  const onStderr = (chunk: Buffer): void => {
    tail = `${tail}${chunk.toString('utf-8')}`.slice(-4096)
    if (ownListenFailureLine(tail, localPort) === null) {
      return
    }
    stop()
    try {
      process.kill('SIGTERM')
    } catch {
      /* already exited */
    }
  }
  process.stderr?.on('data', onStderr)
  process.once('exit', stop)
}

/** `listenerTimeoutMs` requires a listener by then instead of accepting a still-silent forward. */
export function waitForSystemSshForwardStartup(
  process: ChildProcess,
  localPort: number,
  listenerTimeoutMs?: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    let settled = false
    let probeTimer: ReturnType<typeof setTimeout> | null = null
    let graceTimer: ReturnType<typeof setTimeout> | null = null
    const cleanup = (): void => {
      if (probeTimer) {
        clearTimeout(probeTimer)
      }
      if (graceTimer) {
        clearTimeout(graceTimer)
      }
      signal?.removeEventListener('abort', onAbort)
      process.off('error', onError)
      process.off('exit', onExit)
      process.stderr?.off('data', onStderr)
    }
    const finish = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      callback()
    }
    const onAbort = (): void => finish(() => reject(createSshOperationAbortError()))
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString('utf-8')
    }
    const onError = (error: Error): void => {
      finish(() => reject(error))
    }
    const onExit = (code: number | null): void => {
      finish(() => reject(systemSshForwardError(code, stderr, localPort)))
    }
    const scheduleProbe = (): void => {
      probeTimer = setTimeout(() => {
        probeLocalForward(localPort, signal).then(
          () => finish(resolve),
          () => {
            if (!settled) {
              scheduleProbe()
            }
          }
        )
      }, SYSTEM_SSH_FORWARD_LISTENER_PROBE_INTERVAL_MS)
    }

    process.stderr?.on('data', onStderr)
    process.once('error', onError)
    process.once('exit', onExit)
    graceTimer = setTimeout(() => {
      if (listenerTimeoutMs === undefined) {
        finish(resolve)
        return
      }
      finish(() =>
        reject(
          new Error(
            `System SSH port forward did not listen on 127.0.0.1:${localPort} within ${listenerTimeoutMs}ms`
          )
        )
      )
    }, listenerTimeoutMs ?? SYSTEM_SSH_FORWARD_STARTUP_GRACE_MS)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    scheduleProbe()
  })
}

export function waitForSystemSshForwardStop(process: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    let postKillTimer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      clearTimeout(escalationTimer)
      clearTimeout(postKillTimer)
      process.off('exit', onExit)
    }
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve()
    }
    const onExit = (): void => {
      finish()
    }
    const hasExited = (): boolean => process.exitCode !== null || process.signalCode !== null
    const kill = (signal: NodeJS.Signals): void => {
      try {
        const sent = process.kill(signal)
        if (!sent && hasExited()) {
          finish()
        }
      } catch {
        if (hasExited()) {
          finish()
        }
      }
    }
    const escalationTimer = setTimeout(() => {
      // Why: update/reconnect callers must not rebind while a stubborn ssh -L
      // process still owns the local port.
      kill('SIGKILL')
      // Why a second timer: SIGKILL is never acknowledged, so if the runtime never reports the exit —
      // a reparented child, a lost handle — nothing else can settle this promise and quit waits on it
      // forever. Resolving here bounds teardown; it does not claim the child is gone.
      postKillTimer = setTimeout(finish, SYSTEM_SSH_FORWARD_POST_KILL_TIMEOUT_MS)
    }, SYSTEM_SSH_FORWARD_STOP_TIMEOUT_MS)

    // Why before any signal: a child that already exited needs no SIGTERM, and signalling a reaped pid
    // can land on whatever the OS reassigned it to.
    if (hasExited()) {
      finish()
      return
    }
    process.once('exit', onExit)
    kill('SIGTERM')
  })
}

export function systemSshForwardError(
  code: number | null,
  stderr: string,
  localPort?: number
): Error {
  const detail =
    (localPort === undefined ? null : ownListenFailureLine(stderr, localPort)?.trim()) ??
    bestErrorLine(stderr)
  return new Error(
    `System SSH port forward failed${code !== null ? ` (exit ${code})` : ''}${
      detail ? `: ${detail}` : ''
    }`
  )
}

function bestErrorLine(stderr: string): string {
  return (
    stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .findLast(Boolean) ?? ''
  )
}

function probeLocalForward(localPort: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: localPort })
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
      socket.off('connect', onConnect)
      socket.off('error', onError)
      socket.off('timeout', onTimeout)
    }
    const onAbort = (): void => onError(createSshOperationAbortError())
    const onConnect = (): void => {
      cleanup()
      socket.destroy()
      resolve()
    }
    const onError = (err: Error): void => {
      cleanup()
      socket.destroy()
      reject(err)
    }
    const onTimeout = (): void => {
      cleanup()
      socket.destroy()
      reject(new Error(`Timed out probing local forward on 127.0.0.1:${localPort}`))
    }
    socket.setTimeout(SYSTEM_SSH_FORWARD_LISTENER_PROBE_INTERVAL_MS)
    socket.once('connect', onConnect)
    socket.once('error', onError)
    socket.once('timeout', onTimeout)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
    }
  })
}
