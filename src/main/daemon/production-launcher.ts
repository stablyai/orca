import { fork, type ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import {
  serializeDaemonPidFile,
  type DaemonLauncher,
  type DaemonProcessHandle
} from './daemon-spawner'

const READY_TIMEOUT_MS = 10_000

export type ProductionLauncherOptions = {
  getDaemonEntryPath: () => string
}

export function createProductionLauncher(opts: ProductionLauncherOptions): DaemonLauncher {
  return async (
    socketPath: string,
    tokenPath: string,
    pidPath?: string,
    launchNonce?: string
  ): Promise<DaemonProcessHandle> => {
    if ((pidPath === undefined) !== (launchNonce === undefined)) {
      // Why: partial ownership metadata would launch a v24 daemon that cannot
      // prove which PID record it may remove during self-retirement.
      throw new Error('Daemon PID path and launch nonce must be provided together')
    }
    const entryPath = opts.getDaemonEntryPath()

    const child = fork(
      entryPath,
      [
        '--socket',
        socketPath,
        '--token',
        tokenPath,
        ...(pidPath && launchNonce ? ['--pid-record', pidPath, '--launch-nonce', launchNonce] : [])
      ],
      {
        // Why: detached daemon output is not consumed; ignored streams cannot
        // keep Electron alive after the child and IPC channel are unreferenced.
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        detached: true,
        env: { ...process.env },
        ...(process.platform === 'win32' ? { windowsHide: true } : {})
      }
    )

    let startedAtMs: number
    try {
      startedAtMs = await waitForReady(child)
    } catch (error) {
      return rejectAfterChildCleanup(child, error)
    }
    if (pidPath && launchNonce) {
      if (!Number.isSafeInteger(child.pid) || (child.pid as number) <= 0) {
        return rejectAfterChildCleanup(child, new Error('Daemon readiness identity is incomplete'))
      }
      try {
        writeFileSync(
          pidPath,
          serializeDaemonPidFile({
            pid: child.pid as number,
            startedAtMs,
            entryPath,
            launchNonce
          }),
          { mode: 0o600, flag: 'wx' }
        )
      } catch (error) {
        return rejectAfterChildCleanup(child, error)
      }
    }

    // Unref so the Electron process can exit without waiting for the daemon
    child.unref()
    child.disconnect()

    return {
      shutdown: () => shutdownChild(child)
    }
  }
}

function waitForReady(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    let settled = false
    function cleanupStartupListeners(): void {
      if (timeout) {
        clearTimeout(timeout)
      }
      child.off('message', onMessage)
      child.off('error', onError)
      child.off('exit', onExit)
    }
    function fail(error: Error): void {
      if (settled) {
        return
      }
      settled = true
      cleanupStartupListeners()
      reject(error)
    }
    function onMessage(msg: unknown): void {
      if (msg && typeof msg === 'object' && (msg as Record<string, unknown>).type === 'ready') {
        if (settled) {
          return
        }
        const startedAtMs = (msg as { startedAtMs?: unknown }).startedAtMs
        if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs) || startedAtMs <= 0) {
          fail(new Error('Daemon readiness identity is incomplete'))
          return
        }
        settled = true
        // Why: the daemon is detached after readiness, so startup listeners
        // must not keep the child process closure alive for the daemon lifetime.
        cleanupStartupListeners()
        resolve(startedAtMs)
      }
    }
    function onError(err: Error): void {
      fail(new Error(`Daemon process error: ${err.message}`))
    }
    function onExit(code: number | null): void {
      fail(new Error(`Daemon process exited prematurely with code ${code}`))
    }

    timeout = setTimeout(() => {
      fail(new Error('Daemon failed to signal readiness within timeout'))
    }, READY_TIMEOUT_MS)

    child.on('message', onMessage)
    child.on('error', onError)
    child.on('exit', onExit)
  })
}

async function shutdownChild(child: ChildProcess): Promise<void> {
  try {
    if (
      (child.exitCode !== null && child.exitCode !== undefined) ||
      (child.signalCode !== null && child.signalCode !== undefined)
    ) {
      return
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let timeout: ReturnType<typeof setTimeout>
      let forceTimeout: ReturnType<typeof setTimeout> | undefined
      function finish(error?: unknown): void {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        if (forceTimeout) {
          clearTimeout(forceTimeout)
        }
        child.off('exit', onExit)
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }

      function onExit(): void {
        finish()
      }

      timeout = setTimeout(() => {
        try {
          if (child.kill('SIGKILL') === false) {
            finish(new Error('Failed to deliver SIGKILL to daemon'))
            return
          }
        } catch (error) {
          finish(isNoSuchProcessError(error) ? undefined : error)
          return
        }
        // Why: signal delivery is not process exit; keep the listener for one
        // bounded interval before releasing launcher-owned handles.
        if (!settled) {
          forceTimeout = setTimeout(
            () => finish(new Error('Daemon did not exit after SIGKILL')),
            1000
          )
        }
      }, 5000)

      child.once('exit', onExit)
      try {
        if (child.kill('SIGTERM') === false) {
          finish(new Error('Failed to deliver SIGTERM to daemon'))
        }
      } catch (error) {
        finish(isNoSuchProcessError(error) ? undefined : error)
      }
    })
  } finally {
    if (child.connected) {
      child.disconnect()
    }
    child.unref()
  }
}

async function rejectAfterChildCleanup(child: ChildProcess, launchError: unknown): Promise<never> {
  try {
    await shutdownChild(child)
  } catch (cleanupError) {
    throw new AggregateError(
      [launchError, cleanupError],
      'Daemon launch and child cleanup both failed'
    )
  }
  throw launchError
}

function isNoSuchProcessError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'
}
