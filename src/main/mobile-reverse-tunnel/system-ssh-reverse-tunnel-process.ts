import { spawn, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
import { buildSshArgs, findSystemSsh } from '../ssh/ssh-system-fallback'
import type { SshTarget } from '../../shared/ssh-types'

export const SYSTEM_SSH_REVERSE_TUNNEL_STARTUP_GRACE_MS = 1_250
export const SYSTEM_SSH_REVERSE_TUNNEL_ENDPOINT_PROBE_INTERVAL_MS = 150
export const SYSTEM_SSH_REVERSE_TUNNEL_STOP_TIMEOUT_MS = 2_000

export type SystemSshReverseTunnelProcess = {
  process: ChildProcess
  waitForStartup: () => Promise<void>
  close: () => Promise<void>
  dispose: () => void
}

export type SystemSshReverseTunnelOptions = {
  remoteBindHost: string
  remotePort: number
  localHost: string
  localPort: number
  probeHost: string
}

export function spawnSystemSshReverseTunnel(
  target: SshTarget,
  options: SystemSshReverseTunnelOptions
): ChildProcess {
  const sshPath = findSystemSsh()
  if (!sshPath) {
    throw new Error('No system ssh binary found. Install OpenSSH to use SSH tunnels.')
  }

  const args = buildSshArgs(target)
  const destinationIndex = args.lastIndexOf('--')
  const tunnelArgs = [
    '-N',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-R',
    `${options.remoteBindHost}:${options.remotePort}:${options.localHost}:${options.localPort}`
  ]
  if (destinationIndex === -1) {
    args.unshift(...tunnelArgs)
  } else {
    // Why: OpenSSH treats everything after `--` as the destination/command, so
    // reverse-forward options must be inserted before that terminator.
    args.splice(destinationIndex, 0, ...tunnelArgs)
  }

  // Why: this process intentionally uses system ssh so local OpenSSH config,
  // agent, keychain, ProxyJump, and hardware-key support remain compatible.
  return spawn(sshPath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  })
}

export function startSystemSshReverseTunnelProcess(
  target: SshTarget,
  options: SystemSshReverseTunnelOptions
): SystemSshReverseTunnelProcess {
  const process = spawnSystemSshReverseTunnel(target, options)
  return {
    process,
    waitForStartup: () =>
      waitForSystemSshReverseTunnelStartup(process, options.probeHost, options.remotePort),
    close: () => waitForSystemSshReverseTunnelStop(process),
    dispose: () => {
      try {
        process.kill('SIGTERM')
      } catch {
        /* best-effort teardown */
      }
    }
  }
}

export function waitForSystemSshReverseTunnelStartup(
  process: ChildProcess,
  probeHost: string,
  remotePort: number
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
      finish(() => reject(systemSshReverseTunnelError(code, stderr)))
    }
    const scheduleProbe = (): void => {
      probeTimer = setTimeout(() => {
        probeRemoteEndpoint(probeHost, remotePort).then(
          () => finish(resolve),
          () => {
            if (!settled) {
              scheduleProbe()
            }
          }
        )
      }, SYSTEM_SSH_REVERSE_TUNNEL_ENDPOINT_PROBE_INTERVAL_MS)
    }

    process.once('error', onError)
    process.once('exit', onExit)
    process.stderr?.on('data', onStderr)
    scheduleProbe()
    // Why: some firewalls block the public probe while ssh has already accepted
    // the remote forward. Treat a still-running ssh process as started and let
    // the UI expose endpoint test failures separately.
    graceTimer = setTimeout(() => finish(resolve), SYSTEM_SSH_REVERSE_TUNNEL_STARTUP_GRACE_MS)
  })
}

export function waitForSystemSshReverseTunnelStop(process: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (process.exitCode !== null || process.signalCode !== null) {
      resolve()
      return
    }
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const cleanup = (): void => {
      if (killTimer) {
        clearTimeout(killTimer)
      }
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
    const onExit = (): void => finish()
    process.once('exit', onExit)
    try {
      process.kill('SIGTERM')
    } catch {
      finish()
      return
    }
    killTimer = setTimeout(() => {
      try {
        process.kill('SIGKILL')
      } catch {
        /* process may already be gone */
      }
    }, SYSTEM_SSH_REVERSE_TUNNEL_STOP_TIMEOUT_MS)
  })
}

export function probeRemoteEndpoint(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    const cleanup = (): void => {
      socket.removeListener('connect', onConnect)
      socket.removeListener('error', onError)
      socket.removeListener('timeout', onTimeout)
      socket.destroy()
    }
    const onConnect = (): void => {
      cleanup()
      resolve()
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onTimeout = (): void => {
      cleanup()
      reject(new Error(`Timed out connecting to ${host}:${port}`))
    }
    socket.setTimeout(1_500)
    socket.once('connect', onConnect)
    socket.once('error', onError)
    socket.once('timeout', onTimeout)
  })
}

function systemSshReverseTunnelError(code: number | null, stderr: string): Error {
  const detail = stderr.trim()
  if (detail) {
    return new Error(detail)
  }
  return new Error(`SSH reverse tunnel exited before startup${code === null ? '' : ` (${code})`}`)
}
