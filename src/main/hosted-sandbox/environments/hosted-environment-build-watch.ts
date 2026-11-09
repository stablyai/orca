// Follows one environment build's ndjson event stream until the build is final. The control plane
// always replays the log from byte 0, so a reconnect first emits `reset` for consumers to clear.
import type { OrcaCloudEnvironmentBuildStreamEvent } from '../../../shared/hosted-sandbox/hosted-environment-api'
import { hostedEnvironmentErrorMessage } from '../../../shared/hosted-sandbox/hosted-environment-errors'
import {
  HostedEnvironmentBuildStreamLineSchema,
  isTerminalHostedEnvironmentBuildStatus,
  type HostedEnvironmentBuildStatus
} from '../../../shared/hosted-sandbox/hosted-environment-wire'
import {
  HostedEnvironmentRequestError,
  type HostedEnvironmentClient
} from './hosted-environment-client'

export type HostedEnvironmentBuildWatch = {
  stop(): void
  /** Settles after the final event (`end` or `error`) or after stop(). */
  done: Promise<void>
}

export type HostedEnvironmentBuildWatchOptions = {
  client: Pick<HostedEnvironmentClient, 'openBuildEvents' | 'getBuild'>
  envId: string
  buildId: string
  onEvent: (event: OrcaCloudEnvironmentBuildStreamEvent) => void
  /** No bytes (heartbeats included) for this long: ask the build route whether it is still alive. */
  idleTimeoutMs?: number
  /** Quiet periods in a row the build route vouched for before reopening the stream anyway. */
  maxQuietProbes?: number
  /** Delay before reconnect attempt N (1-based), clamped to the last entry. */
  backoffMs?: readonly number[]
  /** Reconnects in a row that brought no new status or log before giving up. */
  maxStalledReconnects?: number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

const DEFAULT_IDLE_TIMEOUT_MS = 90_000
const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const
const DEFAULT_MAX_STALLED_RECONNECTS = 12
// Older control planes send no heartbeat: a silent install is normal, so a quiet stream whose build
// the API still reports as running is kept; only after this many quiet periods is it reopened.
const DEFAULT_MAX_QUIET_PROBES = 3
// One ndjson line holds one log chunk; anything bigger is dropped rather than buffered.
const MAX_LINE_CHARS = 1024 * 1024
const FATAL_CODES = new Set([
  'not_found',
  'forbidden',
  'unauthorized',
  'invalid_request',
  'not_configured',
  'entitlement_denied'
])

type PassOutcome =
  | { kind: 'end' }
  | { kind: 'fatal'; message: string }
  | { kind: 'dropped' }
  | { kind: 'stopped' }

export function watchHostedEnvironmentBuild(
  options: HostedEnvironmentBuildWatchOptions
): HostedEnvironmentBuildWatch {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS
  const maxStalled = options.maxStalledReconnects ?? DEFAULT_MAX_STALLED_RECONNECTS
  const sleep = options.sleep ?? abortableSleep
  const maxQuietProbes = options.maxQuietProbes ?? DEFAULT_MAX_QUIET_PROBES
  const stopper = new AbortController()

  let lastStatus: HostedEnvironmentBuildStatus | null = null
  let emittedAny = false
  // Progress is measured against the longest replay so far: a replay of the same bytes is no progress.
  let bestLogChars = 0
  let passLogChars = 0
  let passStatusChanged = false
  // The build route confirmed the build alive during a quiet pass: its reconnect is not a stall.
  let passVouched = false

  const emit = (event: OrcaCloudEnvironmentBuildStreamEvent): void => {
    if (stopper.signal.aborted) {
      return
    }
    try {
      options.onEvent(event)
    } catch (error) {
      console.warn('[cloud-environments] build event listener threw:', error)
    }
  }

  const handleLine = (line: string): 'end' | 'error' | null => {
    if (!line.trim()) {
      return null
    }
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return null
    }
    const parsed = HostedEnvironmentBuildStreamLineSchema.safeParse(raw)
    if (!parsed.success) {
      return null
    }
    const value = parsed.data
    switch (value.type) {
      case 'build':
        if (value.build.status !== lastStatus) {
          passStatusChanged = true
        }
        lastStatus = value.build.status
        emittedAny = true
        emit({ type: 'build', build: value.build })
        return null
      case 'log':
        passLogChars += value.data.length
        emittedAny = true
        emit({
          type: 'log',
          stream: value.stream,
          data: value.data,
          ...(value.at === undefined ? {} : { at: value.at })
        })
        return null
      case 'heartbeat':
        // The read already re-armed the idle timer; nothing for consumers.
        return null
      case 'end':
        return 'end'
      case 'error':
        return 'error'
    }
  }

  const runPass = async (): Promise<PassOutcome> => {
    passLogChars = 0
    passStatusChanged = false
    passVouched = false
    const pass = new AbortController()
    const onStop = (): void => pass.abort()
    stopper.signal.addEventListener('abort', onStop, { once: true })
    let idle: ReturnType<typeof setTimeout> | null = null
    let quietProbes = 0
    // A quiet stream is not a dead one: ask the build route before tearing the stream down.
    const onIdle = async (): Promise<void> => {
      idle = null
      if (pass.signal.aborted) {
        return
      }
      quietProbes += 1
      const build = await options.client
        .getBuild(options.envId, options.buildId, pass.signal)
        .catch(() => null)
      if (pass.signal.aborted) {
        return
      }
      const alive = build !== null && !isTerminalHostedEnvironmentBuildStatus(build.status)
      if (alive) {
        passVouched = true
      }
      if (alive && build.status === lastStatus && quietProbes < maxQuietProbes) {
        armIdle(false)
        return
      }
      // Finished, changed status, unreachable, or quiet too long: reopen to replay the truth.
      pass.abort()
    }
    const armIdle = (fromData = true): void => {
      if (idle) {
        clearTimeout(idle)
      }
      if (fromData) {
        quietProbes = 0
      }
      idle = setTimeout(() => void onIdle(), idleTimeoutMs)
      idle.unref?.()
    }
    try {
      armIdle()
      let body: ReadableStream<Uint8Array>
      try {
        body = await options.client.openBuildEvents(options.envId, options.buildId, pass.signal)
      } catch (error) {
        if (stopper.signal.aborted) {
          return { kind: 'stopped' }
        }
        if (error instanceof HostedEnvironmentRequestError && FATAL_CODES.has(error.code)) {
          return { kind: 'fatal', message: hostedEnvironmentErrorMessage(error.code, error.reason) }
        }
        return { kind: 'dropped' }
      }
      if (emittedAny) {
        emit({ type: 'reset' })
      }
      const reader = body.getReader()
      const decoder = new TextDecoder()
      let buffered = ''
      let discarding = false
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          armIdle()
          buffered += decoder.decode(value, { stream: true })
          let newline = buffered.indexOf('\n')
          while (newline !== -1) {
            const line = buffered.slice(0, newline)
            buffered = buffered.slice(newline + 1)
            if (discarding) {
              discarding = false
            } else {
              const verdict = handleLine(line)
              if (verdict === 'end') {
                return lastStatus && isTerminalHostedEnvironmentBuildStatus(lastStatus)
                  ? { kind: 'end' }
                  : // Ended before a final status (still booting): follow again.
                    { kind: 'dropped' }
              }
              if (verdict === 'error') {
                return { kind: 'dropped' }
              }
            }
            newline = buffered.indexOf('\n')
          }
          if (buffered.length > MAX_LINE_CHARS) {
            buffered = ''
            discarding = true
          }
        }
        const tail = discarding ? '' : buffered + decoder.decode()
        if (
          tail &&
          handleLine(tail) === 'end' &&
          lastStatus &&
          isTerminalHostedEnvironmentBuildStatus(lastStatus)
        ) {
          return { kind: 'end' }
        }
      } catch {
        // Aborted by idle timer or stop, or the socket broke.
      } finally {
        reader.cancel().catch(() => undefined)
      }
      return stopper.signal.aborted ? { kind: 'stopped' } : { kind: 'dropped' }
    } finally {
      if (idle) {
        clearTimeout(idle)
      }
      stopper.signal.removeEventListener('abort', onStop)
      pass.abort()
    }
  }

  const run = async (): Promise<void> => {
    let stalled = 0
    for (;;) {
      const outcome = await runPass()
      if (outcome.kind === 'stopped' || stopper.signal.aborted) {
        return
      }
      if (outcome.kind === 'end') {
        emit({ type: 'end' })
        return
      }
      if (outcome.kind === 'fatal') {
        emit({ type: 'error', message: outcome.message })
        return
      }
      // A replay of the same status and bytes is no progress, unless the API vouched the build alive.
      const progressed = passStatusChanged || passVouched || passLogChars > bestLogChars
      bestLogChars = Math.max(bestLogChars, passLogChars)
      stalled = progressed ? 1 : stalled + 1
      if (stalled > maxStalled) {
        emit({
          type: 'error',
          message: 'Lost the connection to this build’s log. Reopen it to retry.'
        })
        return
      }
      emit({ type: 'reconnecting' })
      try {
        await sleep(backoff[Math.min(stalled, backoff.length) - 1] ?? 1_000, stopper.signal)
      } catch {
        return
      }
      if (stopper.signal.aborted) {
        return
      }
    }
  }

  const done = run().catch((error: unknown) => {
    console.warn('[cloud-environments] build watch failed:', error)
    emit({ type: 'error', message: 'Could not follow this build.' })
  })

  return {
    stop: () => stopper.abort(),
    done
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
