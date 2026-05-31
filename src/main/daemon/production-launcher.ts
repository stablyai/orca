import { fork, type ChildProcess } from 'child_process'
import type { DaemonLauncher, DaemonProcessHandle } from './daemon-spawner'

const READY_TIMEOUT_MS = 10_000

export type ProductionLauncherOptions = {
  getDaemonEntryPath: () => string
}

export function createProductionLauncher(opts: ProductionLauncherOptions): DaemonLauncher {
  return async (socketPath: string, tokenPath: string): Promise<DaemonProcessHandle> => {
    const entryPath = opts.getDaemonEntryPath()

    const child = fork(entryPath, ['--socket', socketPath, '--token', tokenPath], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: true,
      env: { ...process.env },
      ...(process.platform === 'win32' ? { windowsHide: true } : {})
    })

    await waitForReady(child)

    // Unref so the Electron process can exit without waiting for the daemon
    child.unref()
    child.disconnect()

    return {
      shutdown: () => shutdownChild(child)
    }
  }
}

function waitForReady(child: ChildProcess): Promise<void> {
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
    function fail(error: Error, killChild = false): void {
      if (settled) {
        return
      }
      settled = true
      cleanupStartupListeners()
      if (killChild) {
        child.kill('SIGTERM')
      }
      reject(error)
    }
    function onMessage(msg: unknown): void {
      if (msg && typeof msg === 'object' && (msg as Record<string, unknown>).type === 'ready') {
        if (settled) {
          return
        }
        settled = true
        // Why: the daemon is detached after readiness, so startup listeners
        // must not keep the child process closure alive for the daemon lifetime.
        cleanupStartupListeners()
        resolve()
      }
    }
    function onError(err: Error): void {
      fail(new Error(`Daemon process error: ${err.message}`))
    }
    function onExit(code: number | null): void {
      fail(new Error(`Daemon process exited prematurely with code ${code}`))
    }

    timeout = setTimeout(() => {
      fail(new Error('Daemon failed to signal readiness within timeout'), true)
    }, READY_TIMEOUT_MS)

    child.on('message', onMessage)
    child.on('error', onError)
    child.on('exit', onExit)
  })
}

function shutdownChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.killed) {
      resolve()
      return
    }

    let settled = false
    let timeout: ReturnType<typeof setTimeout>
    function finish(): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      child.off('exit', onExit)
      resolve()
    }

    function onExit(): void {
      finish()
    }

    timeout = setTimeout(() => {
      child.kill('SIGKILL')
      finish()
    }, 5000)

    child.once('exit', onExit)
    child.kill('SIGTERM')
  })
}
