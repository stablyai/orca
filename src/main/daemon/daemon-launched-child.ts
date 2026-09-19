import type { ChildProcess } from 'node:child_process'
import { isDurableDaemonScopeSupported } from './daemon-cgroup-scope'
import { DAEMON_EXIT_ENDPOINT_OCCUPIED } from './daemon-endpoint-ownership'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import {
  spawnDaemonChildProcess,
  type DaemonChildSpawnOptions
} from './daemon-launched-child-spawn'
import { parseDaemonReadyIdentity } from './daemon-ready-identity'
import { unlinkOwnedDaemonPidFile } from './daemon-spawner'

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

export type LaunchedDaemonChild = {
  child: ChildProcess
  identity: DaemonEndpointIdentity
}

/**
 * Why a wrapper instead of one code path: a durable cgroup scope (see `daemon-cgroup-scope.ts`)
 * is what lets the daemon survive a combined-unit `systemctl restart`, but the pre-flight
 * capability probe can still race a real environment fact (a torn-down user session, a polkit
 * policy rejection at the actual `StartTransientUnit` D-Bus call). A scoped attempt that fails
 * for any reason but a lost endpoint race retries once, unscoped, so an environment that cannot
 * support isolation degrades to today's proven behavior instead of failing the launch outright.
 */
export async function launchDaemonChild(
  options: DaemonChildSpawnOptions
): Promise<LaunchedDaemonChild> {
  if (!isDurableDaemonScopeSupported()) {
    return launchDaemonChildAttempt(options, false)
  }
  try {
    return await launchDaemonChildAttempt(options, true)
  } catch (error) {
    if (error instanceof DaemonEndpointUnavailableError) {
      // Not a scope problem: another daemon owns the endpoint and the caller adopts it, so a
      // retry would only fork a second child to lose the same race.
      throw error
    }
    console.warn(
      '[daemon] durable cgroup-scope launch failed, retrying without cgroup isolation:',
      (error as Error).message
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

  // Why: keep only the startup-window stderr tail so a crash cause is visible without unbounded memory.
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
  // Why: release the detached daemon's stderr once up/failed — a live piped stream refs the parent loop and blocks Electron exit.
  const releaseStderr = (): void => {
    collectingStderr = false
    child.stderr?.off('data', onStartupStderr)
    child.stderr?.destroy()
  }

  // Wait for the daemon to signal readiness via IPC
  let launchedIdentity: DaemonEndpointIdentity | null = null
  let endpointUnavailableReason: string | null = null
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
      // Why: attach the captured stderr tail to the thrown error and log it so a startup crash isn't just "exited with code 1".
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
          new AggregateError(
            [startupError, cleanupError],
            'Daemon startup and child cleanup both failed'
          )
        )
        return
      }
      // Best-effort by design: the launch failed before any self-report, so `child.pid` is the
      // only PID available here. `unlinkOwnedDaemonPidFile` matches on both PID and launch
      // nonce, so a mismatch removes nothing rather than clobbering another daemon's record.
      const childPid = child.pid
      if (childPid !== undefined && childPid > 0) {
        unlinkOwnedDaemonPidFile(pidPath, childPid, launchNonce)
      }
      reject(startupError)
    }
    function onReadyMessage(msg: unknown): void {
      if (
        msg &&
        typeof msg === 'object' &&
        (msg as { type?: string }).type === 'endpoint-unavailable'
      ) {
        // Why: the child lost the endpoint race rather than crashing. Record it so the
        // launcher can adopt the winner instead of reporting a generic startup failure.
        endpointUnavailableReason = (msg as { reason?: string }).reason ?? 'occupied'
        void fail(new Error(`Daemon could not take the endpoint: ${endpointUnavailableReason}`))
        return
      }
      if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'ready') {
        if (settled) {
          return
        }
        // Why not `child.pid`: on the durable-scope path the immediate child is `systemd-run`
        // (see daemon-ready-identity.ts); adoption compares this identity against the daemon's
        // own hello-response identity, so both sides must come from inside the daemon process.
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
        // Why: daemon is detached after readiness; detach startup listeners so the launch promise closure isn't retained.
        cleanupStartupListeners()
        // Why: release IPC/stderr and unref so Electron can exit without waiting; the daemon keeps running detached.
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
        // Why here and not only on the IPC message: the exit is the event this wait settles
        // on, so keying off it cannot lose to a notification still in the channel.
        endpointUnavailableReason = 'occupied'
      }
      void fail(new Error(`Daemon exited during startup with code ${code}`))
    }

    timer = setTimeout(() => {
      void fail(new Error('Daemon startup timed out'))
    }, 10000)

    child.on('message', onReadyMessage)
    child.on('error', onStartupError)
    child.on('exit', onStartupExit)
  })

  try {
    await startupSignal
  } catch (error) {
    if (endpointUnavailableReason === 'occupied') {
      throw new DaemonEndpointUnavailableError('occupied', { cause: error })
    }
    throw error
  }
  if (!launchedIdentity) {
    throw new Error('Daemon readiness identity is incomplete')
  }
  return { child, identity: launchedIdentity }
}

/**
 * Startup-failure cleanup only — a successful launch detaches instead (see `onReadyMessage`).
 *
 * Signalling `child.pid` stays correct on the durable-scope path: in `--scope` mode systemd-run
 * registers its *own* PID with the transient unit and then `execvpe()`s the daemon, so that PID
 * is either still systemd-run (scope setup not finished, and killing it aborts the launch) or
 * already the daemon itself. There is never an intermediate process left holding the daemon.
 */
export async function terminateLaunchedDaemonChild(child: ChildProcess): Promise<void> {
  try {
    if (
      (child.exitCode !== null && child.exitCode !== undefined) ||
      (child.signalCode !== null && child.signalCode !== undefined)
    ) {
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
