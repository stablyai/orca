import { spawn, type ChildProcess } from 'node:child_process'
import { connect, createServer, type AddressInfo, type Socket } from 'node:net'
import type { SshTarget } from '../../shared/ssh-types'
import { buildSshArgs, findSystemSsh, type SystemSshBuildArgsOptions } from './ssh-system-fallback'
import { waitForSystemSshForwardStop } from './system-ssh-forward-process'

const STARTUP_TIMEOUT_MS = 10_000
const PROBE_INTERVAL_MS = 50

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
  try {
    await waitForDynamicForward(process, localPort, () => stderr, signal)
  } catch (error) {
    process.stderr?.off('data', onStderr)
    signal?.removeEventListener('abort', onAbort)
    await waitForSystemSshForwardStop(process)
    throw error
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

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | null
      if (!address) {
        server.close()
        reject(new Error('system_ssh_dynamic_forward_port_unavailable'))
        return
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

function waitForDynamicForward(
  process: ChildProcess,
  localPort: number,
  stderr: () => string,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let probeTimer: ReturnType<typeof setTimeout> | undefined
    let probeSocket: Socket | undefined
    const timeout = setTimeout(
      () => finish(() => reject(dynamicForwardError(null, stderr(), 'startup timeout'))),
      STARTUP_TIMEOUT_MS
    )
    const cleanup = (): void => {
      clearTimeout(timeout)
      clearTimeout(probeTimer)
      probeSocket?.removeAllListeners()
      probeSocket?.destroy()
      probeSocket = undefined
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
      const socket = connect({ host: '127.0.0.1', port: localPort })
      probeSocket = socket
      const closeProbe = (): void => {
        if (probeSocket === socket) {
          probeSocket = undefined
        }
        socket.removeAllListeners()
        socket.destroy()
      }
      socket.once('connect', () => {
        closeProbe()
        finish(resolve)
      })
      socket.once('error', () => {
        closeProbe()
        if (!settled) {
          probeTimer = setTimeout(probe, PROBE_INTERVAL_MS)
        }
      })
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
