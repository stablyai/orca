import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isDurableDaemonScopeSupported } from './daemon-cgroup-scope'
import { DAEMON_EXIT_ENDPOINT_OCCUPIED } from './daemon-endpoint-ownership'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import {
  spawnDaemonChildProcess,
  type DaemonChildSpawnOptions
} from './daemon-launched-child-spawn'
import { parseDaemonReadyIdentity } from './daemon-ready-identity'
import { unlinkOwnedDaemonPidFile } from './daemon-spawner'
import { childProcessHasExited } from '@orca/process-host/process-tree-termination'

/** Default readiness IPC budget; callers may allow longer. */
export const DAEMON_CHILD_STARTUP_TIMEOUT_MS = 10_000
const DAEMON_CHILD_TERMINATION_GRACE_MS = 5_000
const DAEMON_CHILD_FORCE_EXIT_WAIT_MS = 1_000
const STARTUP_STDERR_MAX_BYTES = 8192

export class DaemonEndpointUnavailableError extends Error {
  constructor(
    readonly reason: string,
    options?: ErrorOptions
  ) {
    super(`Daemon could not take the endpoint: ${reason}`, options)
  }
}

/** Startup cleanup failed; the child may still be alive. */
class DaemonStartupCleanupError extends AggregateError {}

export type LaunchedDaemonChild = {
  child: ChildProcess
  identity: DaemonEndpointIdentity
}

export async function launchDaemonChild(
  options: DaemonChildSpawnOptions
): Promise<LaunchedDaemonChild> {
  // Probe once: the synchronous systemd-run spawn need not repeat for AppImage fallbacks.
  const scopeSupported = isDurableDaemonScopeSupported()
  const appImageRungs = [
    ...(options.extractedGeneration
      ? [{ from: 'the extracted AppImage copy', options: { ...options, appImage: undefined } }]
      : []),
    ...(options.appImage
      ? [{ from: 'the AppImage', options: { ...options, extractedGeneration: undefined } }]
      : [])
  ]
  for (const rung of appImageRungs) {
    try {
      // A fresh scope nonce avoids colliding with a failed attempt's lingering FUSE server.
      return await launchDaemonChildAttempt(
        { ...rung.options, launchNonce: randomUUID() },
        scopeSupported
      )
    } catch (error) {
      if (
        error instanceof DaemonEndpointUnavailableError ||
        error instanceof DaemonStartupCleanupError
      ) {
        throw error
      }
      // Try the next launch source; the current mount remains available while this window lives.
      console.warn(
        `[daemon] Launch from ${rung.from} failed, ${rung === appImageRungs.at(-1) ? 'retrying from the current mount' : 'falling back'}:`,
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  return launchDaemonChildInEitherScope(
    { ...options, appImage: undefined, extractedGeneration: undefined },
    scopeSupported
  )
}

/** Scope setup can fail after its capability probe; retry unscoped unless another daemon owns the endpoint. */
async function launchDaemonChildInEitherScope(
  options: DaemonChildSpawnOptions,
  scopeSupported: boolean
): Promise<LaunchedDaemonChild> {
  if (!scopeSupported) {
    return launchDaemonChildAttempt(options, false)
  }
  try {
    return await launchDaemonChildAttempt(options, true)
  } catch (error) {
    if (error instanceof DaemonEndpointUnavailableError) {
      // Let the caller adopt the winner instead of launching another child into the same race.
      throw error
    }
    console.warn(
      '[daemon] durable cgroup-scope launch failed, retrying without cgroup isolation:',
      error instanceof Error ? error.message : String(error)
    )
    return launchDaemonChildAttempt(options, false)
  }
}

async function launchDaemonChildAttempt(
  options: DaemonChildSpawnOptions,
  useDurableScope: boolean
): Promise<LaunchedDaemonChild> {
  const { pidPath, launchNonce } = options
  const child = spawnDaemonChildProcess(options, useDurableScope)

  // Bound startup stderr while retaining the crash tail.
  let startupStderr = ''
  let collectingStderr = true
  const onStartupStderr = (chunk: Buffer): void => {
    if (!collectingStderr) {
      return
    }
    startupStderr += chunk.toString('utf8')
    if (startupStderr.length > STARTUP_STDERR_MAX_BYTES) {
      startupStderr = startupStderr.slice(-STARTUP_STDERR_MAX_BYTES)
    }
  }
  child.stderr?.on('data', onStartupStderr)
  // A live stderr pipe retains the parent event loop and blocks Electron exit.
  const releaseStderr = (): void => {
    collectingStderr = false
    child.stderr?.off('data', onStartupStderr)
    child.stderr?.destroy()
  }

  let launchedIdentity: DaemonEndpointIdentity | null = null
  let endpointOccupied = false
  const startupSignal = new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    function cleanupStartupListeners(): void {
      if (timer) {
        clearTimeout(timer)
      }
      child.off('message', onReadyMessage)
      child.off('error', onStartupError)
      child.off('exit', onStartupExit)
    }
    async function fail(error: Error): Promise<void> {
      if (settled) {
        return
      }
      settled = true
      cleanupStartupListeners()
      const stderrTail = startupStderr.trim()
      if (stderrTail) {
        console.warn(`[daemon] startup failed; captured stderr tail:\n${stderrTail}`)
      }
      releaseStderr()
      const startupError = stderrTail
        ? new Error(`${error.message}\nDaemon stderr (tail):\n${stderrTail}`)
        : error
      try {
        await terminateLaunchedDaemonChild(child)
      } catch (cleanupError) {
        reject(
          new DaemonStartupCleanupError(
            [startupError, cleanupError],
            'Daemon startup and child cleanup both failed'
          )
        )
        return
      }
      // Before self-report, child.pid is all we have; PID and nonce must both match before unlinking.
      const childPid = child.pid
      if (childPid !== undefined && childPid > 0) {
        unlinkOwnedDaemonPidFile(pidPath, childPid, launchNonce)
      }
      reject(startupError)
    }
    function onReadyMessage(msg: unknown): void {
      if (!msg || typeof msg !== 'object') {
        return
      }
      const type = 'type' in msg ? msg.type : undefined
      if (type === 'endpoint-unavailable') {
        // Preserve the endpoint-race outcome so the launcher can adopt the winner.
        const reason = 'reason' in msg && typeof msg.reason === 'string' ? msg.reason : 'occupied'
        endpointOccupied = reason === 'occupied'
        void fail(new Error(`Daemon could not take the endpoint: ${reason}`))
        return
      }
      if (type === 'ready') {
        if (settled) {
          return
        }
        // Match hello against the daemon's own identity; child.pid may still identify a wrapper.
        const readyIdentity = parseDaemonReadyIdentity(msg)
        if (!readyIdentity) {
          void fail(new Error('Daemon readiness identity is incomplete'))
          return
        }
        launchedIdentity = {
          ...readyIdentity,
          launchNonce
        }
        settled = true
        // Release listeners so they do not retain the launch closure.
        cleanupStartupListeners()
        // Release parent event-loop references while the detached daemon keeps running.
        releaseStderr()
        child.disconnect()
        child.unref()
        resolve()
      }
    }

    function onStartupError(err: Error): void {
      void fail(err)
    }

    function onStartupExit(code: number | null): void {
      if (code === DAEMON_EXIT_ENDPOINT_OCCUPIED) {
        // Exit may settle this wait before the occupied-endpoint IPC notification arrives.
        endpointOccupied = true
      }
      void fail(new Error(`Daemon exited during startup with code ${code}`))
    }

    timer = setTimeout(() => {
      void fail(new Error('Daemon startup timed out'))
    }, options.startupTimeoutMs ?? DAEMON_CHILD_STARTUP_TIMEOUT_MS)

    child.on('message', onReadyMessage)
    child.on('error', onStartupError)
    child.on('exit', onStartupExit)
  })

  try {
    await startupSignal
  } catch (error) {
    if (endpointOccupied) {
      throw new DaemonEndpointUnavailableError('occupied', { cause: error })
    }
    throw error
  }
  if (!launchedIdentity) {
    throw new Error('Daemon readiness identity is incomplete')
  }
  return { child, identity: launchedIdentity }
}

/** On failure, signal child.pid: systemd-run --scope execs the daemon in place, without an intermediate child. */
export async function terminateLaunchedDaemonChild(child: ChildProcess): Promise<void> {
  try {
    if (childProcessHasExited(child)) {
      return
    }
    await new Promise<void>((resolve, reject) => {
      let gracefulTimer: ReturnType<typeof setTimeout>
      let forcedTimer: ReturnType<typeof setTimeout> | undefined
      let settled = false
      const finish = (error?: unknown): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(gracefulTimer)
        if (forcedTimer) {
          clearTimeout(forcedTimer)
        }
        child.off('exit', onExit)
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }
      const onExit = (): void => finish()
      child.on('exit', onExit)
      gracefulTimer = setTimeout(() => {
        if (child.pid) {
          try {
            process.kill(child.pid, 'SIGKILL')
          } catch (error) {
            finish(isNoSuchProcessError(error) ? undefined : error)
            return
          }
        }
        if (!settled) {
          forcedTimer = setTimeout(
            () => finish(new Error('Daemon did not exit after SIGKILL')),
            DAEMON_CHILD_FORCE_EXIT_WAIT_MS
          )
        }
      }, DAEMON_CHILD_TERMINATION_GRACE_MS)
      if (child.pid) {
        try {
          process.kill(child.pid, 'SIGTERM')
        } catch (error) {
          finish(isNoSuchProcessError(error) ? undefined : error)
        }
      } else {
        finish()
      }
    })
  } finally {
    if (child.connected) {
      child.disconnect()
    }
    child.unref()
  }
}

function isNoSuchProcessError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'
}
