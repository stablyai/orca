import type { ChildProcess } from 'node:child_process'
import { parseServeSupervisorMessage } from '../../shared/serve-update-handoff'
import type { ServeRuntimeHealth } from './serve-runtime-health'

export const SERVE_REPLACEMENT_READY_TIMEOUT_MS = 60_000
export const SERVE_HEALTH_CHECK_INTERVAL_MS = 10_000
export const SERVE_HEALTH_PROBE_TIMEOUT_MS = 5_000
export const SERVE_HEALTH_FAILURE_LIMIT = 3

type ServeReadiness = 'not-expected' | 'pending' | 'verified' | 'failed'

export type ExpectedServeReadiness = {
  targetVersion: string
  recordFailure: (reason: string) => Promise<void>
  complete: (runtimeId: string) => Promise<void>
}

export type ServeChildMonitorOptions = {
  healthProbe?: () => Promise<ServeRuntimeHealth>
  onVerified?: (runtimeId: string) => Promise<void>
  healthCheckIntervalMs: number
  healthProbeTimeoutMs: number
  healthFailureLimit: number
}

export type ServeChildExit = {
  code: number | null
  signal: NodeJS.Signals | null
  readiness: ServeReadiness
  terminationRequested: boolean
  healthFailureReason: string | null
  healthyDurationMs: number
}

export function waitForForegroundServeChild(
  child: ChildProcess,
  expected: ExpectedServeReadiness | null,
  options: ServeChildMonitorOptions
): Promise<ServeChildExit> {
  return new Promise((resolveWait, reject) => {
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null
    let readyTimer: ReturnType<typeof setTimeout> | null = null
    let healthTimer: ReturnType<typeof setTimeout> | null = null
    let readiness: ServeReadiness = expected || options.healthProbe ? 'pending' : 'not-expected'
    let stateWrite = Promise.resolve()
    let terminationRequested = false
    let healthFailureReason: string | null = null
    let healthySince: number | null = null
    let healthProbeInFlight = false
    let consecutiveHealthFailures = 0
    let settled = false

    const terminateChild = (): void => {
      child.kill('SIGTERM')
      forceKillTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000)
    }
    const recordReadinessFailure = (reason: string): boolean => {
      if (readiness !== 'pending') {
        return false
      }
      readiness = 'failed'
      if (readyTimer) {
        clearTimeout(readyTimer)
        readyTimer = null
      }
      if (expected) {
        stateWrite = expected.recordFailure(reason).catch((error) => {
          process.stderr.write(
            `[serve] could not record update handoff failure: ${String(error)}\n`
          )
        })
      } else {
        process.stderr.write(`[serve] startup health check failed: ${reason}\n`)
      }
      return true
    }
    const rejectReadiness = (reason: string): void => {
      if (recordReadinessFailure(reason)) {
        terminateChild()
      }
    }
    const forwardSignal = (signal: NodeJS.Signals): void => {
      terminationRequested = true
      child.kill(signal)
      forceKillTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000)
    }
    const scheduleHealthCheck = (runtimeId: string): void => {
      if (!options.healthProbe || settled || readiness !== 'verified') {
        return
      }
      healthTimer = setTimeout(() => {
        void runHealthCheck(runtimeId)
      }, options.healthCheckIntervalMs)
      healthTimer.unref?.()
    }
    const probeHealthWithDeadline = async (): Promise<ServeRuntimeHealth> =>
      await new Promise((resolveHealth) => {
        let completed = false
        const finish = (health: ServeRuntimeHealth): void => {
          if (completed) {
            return
          }
          completed = true
          clearTimeout(timeout)
          resolveHealth(health)
        }
        const timeout = setTimeout(
          () => finish({ healthy: false, reason: 'runtime_unreachable' }),
          options.healthProbeTimeoutMs
        )
        timeout.unref?.()
        void Promise.resolve()
          .then(() => options.healthProbe!())
          .then(finish, () => finish({ healthy: false, reason: 'runtime_unreachable' }))
      })
    const runHealthCheck = async (runtimeId: string): Promise<void> => {
      const health = await probeHealthWithDeadline()
      if (settled || readiness !== 'verified') {
        return
      }
      if (health.healthy && health.runtimeId === runtimeId) {
        consecutiveHealthFailures = 0
        scheduleHealthCheck(runtimeId)
        return
      }
      consecutiveHealthFailures += 1
      if (consecutiveHealthFailures < options.healthFailureLimit) {
        scheduleHealthCheck(runtimeId)
        return
      }
      healthFailureReason = health.healthy ? 'runtime_changed' : health.reason
      process.stderr.write(
        `[serve] runtime health failed ${consecutiveHealthFailures} consecutive checks (${healthFailureReason}); restarting main.\n`
      )
      terminateChild()
    }
    const verifyReadyMessage = async (runtimeId: string): Promise<void> => {
      // The readiness timer bounds this probe, and the pending guard ignores late completion.
      const health = options.healthProbe ? await options.healthProbe() : null
      if (settled || readiness !== 'pending') {
        return
      }
      if (health && (!health.healthy || health.runtimeId !== runtimeId)) {
        rejectReadiness(
          health.healthy ? 'Runtime identity changed during readiness.' : health.reason
        )
        return
      }
      readiness = 'verified'
      healthySince = Date.now()
      if (readyTimer) {
        clearTimeout(readyTimer)
        readyTimer = null
      }
      if (expected) {
        stateWrite = expected.complete(runtimeId).catch((error) => {
          readiness = 'failed'
          process.stderr.write(`[serve] could not complete update handoff: ${String(error)}\n`)
          terminateChild()
        })
      }
      if (options.onVerified) {
        stateWrite = stateWrite
          .then(() => options.onVerified!(runtimeId))
          .catch((error) => {
            process.stderr.write(`[serve] could not process verified readiness: ${String(error)}\n`)
          })
      }
      scheduleHealthCheck(runtimeId)
    }
    const handleMessage = (value: unknown): void => {
      const message = parseServeSupervisorMessage(value)
      if (!message || readiness !== 'pending') {
        return
      }
      if (expected && message.version !== expected.targetVersion) {
        rejectReadiness(
          `Replacement reported version ${message.version}; expected ${expected.targetVersion}.`
        )
        return
      }
      if (
        message.health &&
        (message.health.websocket !== 'ready' ||
          message.health.runtime !== 'ready' ||
          message.health.graph !== 'ready')
      ) {
        rejectReadiness('Child reported an unavailable WebSocket, runtime, or graph.')
        return
      }
      if (healthProbeInFlight) {
        return
      }
      healthProbeInFlight = true
      void verifyReadyMessage(message.runtimeId)
        .catch(() => rejectReadiness('runtime_unreachable'))
        .finally(() => {
          healthProbeInFlight = false
        })
    }
    const cleanup = (): void => {
      process.off('SIGINT', forwardSignal)
      process.off('SIGTERM', forwardSignal)
      if (typeof child.off === 'function') {
        child.off('message', handleMessage)
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
      }
      if (readyTimer) {
        clearTimeout(readyTimer)
      }
      if (healthTimer) {
        clearTimeout(healthTimer)
      }
    }
    const handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      void stateWrite.then(() =>
        resolveWait({
          code,
          signal,
          readiness,
          terminationRequested,
          healthFailureReason,
          healthyDurationMs: healthySince === null ? 0 : Math.max(0, Date.now() - healthySince)
        })
      )
    }

    process.on('SIGINT', forwardSignal)
    process.on('SIGTERM', forwardSignal)
    if (typeof child.on === 'function') {
      child.on('message', handleMessage)
    }
    if (readiness === 'pending') {
      readyTimer = setTimeout(() => {
        rejectReadiness(
          expected
            ? `Replacement did not report serving version ${expected.targetVersion} within ${SERVE_REPLACEMENT_READY_TIMEOUT_MS}ms.`
            : `Main process did not report healthy serve readiness within ${SERVE_REPLACEMENT_READY_TIMEOUT_MS}ms.`
        )
      }, SERVE_REPLACEMENT_READY_TIMEOUT_MS)
    }
    child.once('error', (error) => {
      recordReadinessFailure(`Could not start the replacement process: ${String(error)}`)
      child.off('exit', handleExit)
      if (!expected) {
        handleExit(1, null)
        return
      }
      cleanup()
      // Why: the LaunchAgent may restart this parent immediately, so durable failure must precede process rejection.
      void stateWrite.then(() => reject(error))
    })
    child.once('exit', handleExit)
  })
}
