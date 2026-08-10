import { spawn, type ChildProcess } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { buildSshArgs, findSystemSsh, type SystemSshBuildArgsOptions } from './ssh-system-fallback'
import type { SshTarget } from '../../shared/ssh-types'

export const SYSTEM_SSH_FORWARD_STARTUP_GRACE_MS = 750
export const SYSTEM_SSH_FORWARD_LISTENER_PROBE_INTERVAL_MS = 50
export const SYSTEM_SSH_FORWARD_STOP_TIMEOUT_MS = 2_000
// Why short: SIGKILL is uncatchable, so a child that has not reported exit this long after it is
// either already reaped or beyond anything teardown can do about it.
export const SYSTEM_SSH_FORWARD_POST_KILL_TIMEOUT_MS = 500

export type SystemSshPortForwardProcess = {
  process: ChildProcess
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

  const args = buildSshArgs(target, { ...options, suppressOrcaControlMaster: true })
  const destinationIndex = args.lastIndexOf('--')
  const forwardArgs = [
    '-N',
    '-o',
    'ExitOnForwardFailure=yes',
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

  // Why: port-forward ssh processes are not wired to Orca credential prompts;
  // system SSH forwards must authenticate via OpenSSH config, agent, or control socket.
  return spawn(sshPath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  })
}

export function startSystemSshPortForwardProcess(
  target: SshTarget,
  localPort: number,
  remoteHost: string,
  remotePort: number,
  options?: SystemSshBuildArgsOptions
): Promise<SystemSshPortForwardProcess> {
  return assertLocalForwardPortAvailable(localPort).then(() => {
    const process = spawnSystemSshPortForward(target, localPort, remoteHost, remotePort, options)
    return {
      process,
      waitForStartup: () => waitForSystemSshForwardStartup(process, localPort),
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

export function assertLocalForwardPortAvailable(localPort: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    const cleanup = (): void => {
      server.removeListener('error', onError)
      server.removeListener('listening', onListening)
    }
    const onError = (err: Error): void => {
      cleanup()
      reject(new Error(`Local port 127.0.0.1:${localPort} is not available: ${err.message}`))
    }
    const onListening = (): void => {
      cleanup()
      server.close(() => resolve())
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(localPort, '127.0.0.1')
  })
}

export function waitForSystemSshForwardStartup(
  process: ChildProcess,
  localPort: number
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
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString('utf-8')
    }
    const onError = (error: Error): void => {
      finish(() => reject(error))
    }
    const onExit = (code: number | null): void => {
      finish(() => reject(systemSshForwardError(code, stderr)))
    }
    const scheduleProbe = (): void => {
      probeTimer = setTimeout(() => {
        probeLocalForward(localPort).then(
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
      finish(resolve)
    }, SYSTEM_SSH_FORWARD_STARTUP_GRACE_MS)
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

export function systemSshForwardError(code: number | null, stderr: string): Error {
  const detail = bestErrorLine(stderr)
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

function probeLocalForward(localPort: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: localPort })
    const cleanup = (): void => {
      socket.off('connect', onConnect)
      socket.off('error', onError)
      socket.off('timeout', onTimeout)
    }
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
  })
}
