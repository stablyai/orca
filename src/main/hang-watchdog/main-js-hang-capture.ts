import { reduceHangProfile } from './hang-profile-reducer'
import type { Profiler, Session } from 'node:inspector'
import { emptyHangStacks, type MainJsCapture } from './hang-stacks'

type ProfilerCommandParameters = { interval?: number }
type CaptureSession = Pick<Session, 'connectToMainThread' | 'disconnect'> & {
  post: (
    method: string,
    params: ProfilerCommandParameters,
    callback: (error: Error | null, result?: unknown) => void
  ) => void
}
type StopReason = NonNullable<MainJsCapture['stopReason']>

function reduceStopResult(value: unknown): Partial<MainJsCapture> | null {
  if (!value || typeof value !== 'object' || !('profile' in value)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a successful Profiler.stop response supplies the inspector's typed profile.
  const profile = value.profile as Profiler.Profile
  const reduced = reduceHangProfile(profile)
  const duration = (profile.endTime - profile.startTime) / 1000
  return {
    ...reduced,
    state: 'completed',
    ...(Number.isFinite(duration) && duration >= 0 ? { profileDurationMs: duration } : {})
  }
}

export function captureMainJsHang(options: {
  session: CaptureSession
  now: () => number
  detectedAt: number
  publish: (capture: MainJsCapture) => void
  drain: () => Promise<void>
}): { stop: (reason: StopReason) => void; done: Promise<void> } {
  let intent: StopReason | undefined
  let wake: (() => void) | undefined
  let transportUncertain = false
  let capture: MainJsCapture = {
    ...emptyHangStacks(),
    state: 'collecting',
    cleanup: 'pending',
    samplingIntervalUs: 10_000,
    requestedCaptureMs: 5_000,
    budgetBasis: 'detection',
    overlap: 'unconfirmed'
  }
  const elapsed = (): number => Math.max(0, options.now() - options.detectedAt)
  const publish = (change: Partial<MainJsCapture>): void => {
    capture = { ...capture, ...change }
    options.publish(capture)
  }
  const stop = (reason: StopReason): void => {
    if (intent) {
      return
    }
    intent = reason
    publish({ stopReason: reason, stopRequestedAfterDetectionMs: elapsed(), state: 'stop-pending' })
    wake?.()
  }
  const canStart = (): boolean => {
    if (elapsed() >= 5_000) {
      stop('deadline')
    }
    return !intent
  }
  const deadline = setTimeout(() => stop('deadline'), Math.max(0, 5_000 - elapsed()))
  publish({})
  const post = (
    method: string,
    params: ProfilerCommandParameters = {}
  ): Promise<{ ok: boolean; result?: unknown }> =>
    new Promise((resolve) => {
      // Exactly one caller awaits each response before the next command or disconnect.
      try {
        options.session.post(method, params, (error, result) => resolve({ ok: !error, result }))
      } catch {
        transportUncertain = true
        resolve({ ok: false })
      }
    })
  const done = (async (): Promise<void> => {
    let connected = false
    let enabled = false
    let started = false
    let cleanupSafe = true
    try {
      options.session.connectToMainThread()
      connected = true
      enabled = (await post('Profiler.enable')).ok
      if (!enabled) {
        publish({ state: 'failed' })
      }
      if (enabled && canStart()) {
        const interval = await post('Profiler.setSamplingInterval', { interval: 10_000 })
        if (!interval.ok) {
          stop('deadline')
          publish({ state: 'failed' })
        }
        if (interval.ok && canStart()) {
          publish({ startPostedAfterDetectionMs: elapsed() })
          started = (await post('Profiler.start')).ok
          publish({
            startAcknowledgedAfterDetectionMs: elapsed(),
            ...(!started ? { state: 'failed' as const } : {})
          })
        }
      }
      if (started) {
        canStart()
        if (!intent) {
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
        publish({ stopPostedAfterDetectionMs: elapsed() })
        const result = await post('Profiler.stop')
        const acknowledged = elapsed()
        publish({
          stopAcknowledgedAfterDetectionMs: acknowledged,
          stopAckDelayMs: acknowledged - (capture.stopPostedAfterDetectionMs ?? acknowledged)
        })
        const reduced = result.ok ? reduceStopResult(result.result) : null
        result.result = undefined
        if (reduced) {
          publish(reduced)
          started = false
        } else {
          cleanupSafe = false
          publish({ state: 'failed' })
        }
      } else if (capture.state !== 'failed') {
        publish({ state: 'not-started' })
      }
      if (enabled && !started) {
        cleanupSafe = (await post('Profiler.disable')).ok
        if (!cleanupSafe) {
          publish({ state: 'failed' })
        }
      }
      if (transportUncertain) {
        cleanupSafe = false
      }
      if (connected && cleanupSafe && !started) {
        options.session.disconnect()
        await options.drain()
        publish({ cleanup: 'drain-complete' })
      }
      if (!cleanupSafe || started) {
        // Keep the physical owner; an error is not proof the profiler stopped.
        await new Promise<void>(() => {})
      }
    } catch {
      publish({ state: 'failed' })
      if (connected) {
        await new Promise<void>(() => {})
      }
    } finally {
      clearTimeout(deadline)
      wake = undefined
    }
  })()
  return { stop, done }
}
