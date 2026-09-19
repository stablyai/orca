import { spawn, type ChildProcess } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import type { SshTarget } from '../../shared/ssh-types'
import { buildSshArgs, findSystemSsh, type SystemSshBuildArgsOptions } from './ssh-system-fallback'
import { waitForSystemSshForwardStop } from './system-ssh-forward-process'
import { allocateLoopbackPort } from './loopback-port-allocation'
import { TransportPublicationDrain } from '../../shared/transport-publication-drain'

const STARTUP_TIMEOUT_MS = 10_000
const PROBE_INTERVAL_MS = 50

export class SystemSshDynamicForwardStartupRetiredError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'SystemSshDynamicForwardStartupRetiredError'
  }
}

export type SystemSshDynamicForwardProcess = {
  localPort: number
  process: ChildProcess
  stderrTail: () => string
  close: () => Promise<void>
  dispose: () => void
}

export async function startSystemSshDynamicForwardProcess(
  target: SshTarget,
  options?: SystemSshBuildArgsOptions,
  signal?: AbortSignal
): Promise<SystemSshDynamicForwardProcess> {
  const sshPath = findSystemSsh()
  if (!sshPath) {
    throw new Error('No system ssh binary found. Install OpenSSH to use browser tunneling.')
  }
  const localPort = await allocateLoopbackPort()
  if (signal?.aborted) {
    throw new Error('system_ssh_dynamic_forward_aborted')
  }
  const args = buildSshArgs(target, {
    ...options,
    suppressOrcaControlMaster: true,
    disableControlMaster: true,
    nonInteractive: true
  })
  const destinationIndex = args.lastIndexOf('--')
  const dynamicArgs = ['-N', '-o', 'ExitOnForwardFailure=yes', '-D', `127.0.0.1:${localPort}`]
  args.splice(destinationIndex === -1 ? 0 : destinationIndex, 0, ...dynamicArgs)
  const process = spawn(sshPath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  })
  let stderr = ''
  const onStderr = (chunk: Buffer): void => {
    stderr = `${stderr}${chunk.toString('utf-8')}`.slice(-64 * 1024)
  }
  const onAbort = (): void => {
    try {
      process.kill('SIGTERM')
    } catch {
      /* best-effort cancellation */
    }
  }
  process.stderr?.on('data', onStderr)
  signal?.addEventListener('abort', onAbort, { once: true })
  const probes = new TransportPublicationDrain(() => {})
  try {
    await waitForDynamicForward(process, localPort, () => stderr, probes, signal)
    await probes.drain(signal ?? new AbortController().signal)
    signal?.throwIfAborted()
  } catch (error) {
    process.stderr?.off('data', onStderr)
    signal?.removeEventListener('abort', onAbort)
    await waitForSystemSshForwardStop(process)
    await probes.drain(new AbortController().signal)
    throw new SystemSshDynamicForwardStartupRetiredError(error)
  }
  return {
    localPort,
    process,
    stderrTail: () => stderr,
    close: async () => {
      try {
        await waitForSystemSshForwardStop(process)
      } finally {
        process.stderr?.off('data', onStderr)
        signal?.removeEventListener('abort', onAbort)
      }
    },
    dispose: () => {
      try {
        process.kill('SIGTERM')
      } catch {
        /* best-effort teardown */
      }
    }
  }
}

function waitForDynamicForward(
  process: ChildProcess,
  localPort: number,
  stderr: () => string,
  probes: TransportPublicationDrain,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let probeTimer: ReturnType<typeof setTimeout> | undefined
    let closeCurrentProbe: (() => void) | undefined
    const timeout = setTimeout(
      () => finish(() => reject(dynamicForwardError(null, stderr(), 'startup timeout'))),
      STARTUP_TIMEOUT_MS
    )
    const cleanup = (): void => {
      clearTimeout(timeout)
      clearTimeout(probeTimer)
      closeCurrentProbe?.()
      process.off('error', onError)
      process.off('exit', onExit)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (settle: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      settle()
    }
    const onError = (error: Error): void => finish(() => reject(error))
    const onAbort = (): void =>
      finish(() => reject(new Error('system_ssh_dynamic_forward_aborted')))
    const onExit = (code: number | null): void =>
      finish(() => reject(dynamicForwardError(code, stderr())))
    const probe = (): void => {
      const settleProbe = probes.trackWrite()
      let socket: Socket
      try {
        socket = connect({ host: '127.0.0.1', port: localPort })
      } catch (error) {
        settleProbe({ ok: false, error: error instanceof Error ? error : new Error(String(error)) })
        finish(() => reject(error))
        return
      }
      const ignoreError = (): void => {}
      socket.on('error', ignoreError)
      socket.once('close', () => {
        socket.off('error', ignoreError)
        settleProbe({ ok: true })
      })
      const closeProbe = (): void => {
        if (closeCurrentProbe === closeProbe) {
          closeCurrentProbe = undefined
        }
        socket.off('connect', onConnect)
        socket.off('error', onProbeError)
        socket.destroy()
      }
      const onConnect = (): void => {
        closeProbe()
        finish(resolve)
      }
      const onProbeError = (): void => {
        closeProbe()
        if (!settled) {
          probeTimer = setTimeout(probe, PROBE_INTERVAL_MS)
        }
      }
      closeCurrentProbe = closeProbe
      socket.once('connect', onConnect)
      socket.once('error', onProbeError)
    }
    process.once('error', onError)
    process.once('exit', onExit)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    probe()
  })
}

function dynamicForwardError(code: number | null, stderr: string, fallback = ''): Error {
  const detail =
    stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .findLast(Boolean) ?? fallback
  return new Error(
    `System SSH dynamic forward failed${code === null ? '' : ` (exit ${code})`}${
      detail ? `: ${detail}` : ''
    }`
  )
}
