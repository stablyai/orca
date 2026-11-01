import { trackSshConnectionChannelLifetime } from './connection/ssh-connection-channel-lifetime'
import { CONNECT_TIMEOUT_MS } from './connection/ssh-connection-timing'
import { createSshOperationAbortError } from './connection/ssh-exec-options'
import { isSshSessionLimitError } from './ssh-session-limit-error'

// Upper bound on waiting for an aborted channel's open/close to settle before rejecting anyway.
const ABORTED_CHANNEL_CLOSE_GRACE_MS = 5_000

// MaxSessions refusal ran no command, so bounded open retry is safe.
const SESSION_LIMIT_OPEN_RETRIES = 4
const SESSION_LIMIT_OPEN_RETRY_DELAY_MS = 150

/** Open timeout is lost contact, never a negative host answer. */
export function sshChannelOpenTimeoutError(message: string): Error {
  return Object.assign(new Error(message), { name: 'SshChannelOpenTimeoutError' })
}

export async function openSshSessionChannelWithRetry<T>(
  open: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < SESSION_LIMIT_OPEN_RETRIES; attempt++) {
    if (attempt > 0) {
      // Abort must interrupt backoff immediately.
      if (!signal?.aborted) {
        await new Promise<void>((resolve) => {
          const onDelayDone = (): void => {
            clearTimeout(delayTimer)
            signal?.removeEventListener('abort', onDelayDone)
            resolve()
          }
          const delayTimer = setTimeout(onDelayDone, SESSION_LIMIT_OPEN_RETRY_DELAY_MS)
          signal?.addEventListener('abort', onDelayDone, { once: true })
        })
      }
      if (signal?.aborted) {
        throw createSshOperationAbortError()
      }
    }
    try {
      return await open()
    } catch (err) {
      if (!isSshSessionLimitError(err)) {
        throw err
      }
      lastError = err
    }
  }
  throw lastError
}

export function waitForSshChannelOpen<T>(
  timeoutMessage: string,
  register: (callback: (error: Error | undefined, value: T) => void) => void,
  cleanupLateValue?: (value: T) => void,
  signal?: AbortSignal,
  trackRemoteCommandTermination = false,
  onUnhandledError?: (error: Error) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    type ChannelOpenTerminationError = Error & { sshChannelCloseConfirmed: boolean }
    let settled = false
    let unconfirmedOpenError: ChannelOpenTerminationError | null = null
    const markOpenUnconfirmed = (error: Error): Error => {
      if (!trackRemoteCommandTermination) {
        return error
      }
      unconfirmedOpenError = Object.assign(error, { sshChannelCloseConfirmed: false })
      return unconfirmedOpenError
    }
    // Abort requests close, but settle only after a late opened channel releases its MaxSessions slot.
    let abortRequested = false
    let abortDeadlineTimer: NodeJS.Timeout | undefined
    const cleanup = (): void => {
      clearTimeout(timer)
      clearTimeout(abortDeadlineTimer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      abortRequested = true
      // Bound abort wait even if the hung socket never invokes its open callback.
      abortDeadlineTimer = setTimeout(() => {
        settled = true
        cleanup()
        reject(markOpenUnconfirmed(createSshOperationAbortError()))
      }, ABORTED_CHANNEL_CLOSE_GRACE_MS)
    }
    const timer = setTimeout(() => {
      settled = true
      cleanup()
      reject(
        markOpenUnconfirmed(
          abortRequested
            ? createSshOperationAbortError()
            : sshChannelOpenTimeoutError(timeoutMessage)
        )
      )
    }, CONNECT_TIMEOUT_MS)
    const discardLateValue = (value: T, onClose?: () => void): void => {
      const emitter = value as Partial<NodeJS.EventEmitter> & {
        resume?: () => void
        stderr?: Partial<NodeJS.EventEmitter> & { resume?: () => void }
      }
      const swallowLateError = (): void => {}
      emitter.on?.('error', swallowLateError)
      emitter.stderr?.on?.('error', swallowLateError)
      if (onClose) {
        emitter.once?.('close', onClose)
      }
      // Drain discarded streams for CHANNEL_CLOSE and own errors no caller can observe.
      emitter.resume?.()
      emitter.stderr?.resume?.()
      try {
        cleanupLateValue?.(value)
      } catch {}
    }
    const rejectAfterClose = (value: T): void => {
      const abortError = markOpenUnconfirmed(createSshOperationAbortError())
      const emitter = value as Partial<NodeJS.EventEmitter> & {
        resume?: () => void
        stderr?: { resume?: () => void }
      }
      let finished = false
      const done = (): void => {
        if (finished) {
          return
        }
        finished = true
        clearTimeout(closeGraceTimer)
        emitter.removeListener?.('close', confirmAndDone)
        reject(abortError)
      }
      const confirmAndDone = (): void => {
        if (unconfirmedOpenError === abortError) {
          unconfirmedOpenError.sshChannelCloseConfirmed = true
        }
        done()
      }
      // Bound waiting when the host never confirms close.
      const closeGraceTimer = setTimeout(done, ABORTED_CHANNEL_CLOSE_GRACE_MS)
      if (typeof emitter.once === 'function') {
        emitter.once('close', confirmAndDone)
      }
      // Drain before waiting for close because ssh2 withholds it until streams are consumed.
      discardLateValue(value)
      if (typeof emitter.once !== 'function') {
        done()
      }
    }
    const finish = (error: Error | undefined, value?: T): void => {
      // Late channels still need lifetime error ownership after caller timeout.
      if (!error && value !== undefined) {
        trackSshConnectionChannelLifetime(value, onUnhandledError)
      }
      if (settled) {
        // Close channels opened after timeout so no unowned session leaks.
        if (!error && value !== undefined) {
          discardLateValue(value, () => {
            if (unconfirmedOpenError) {
              unconfirmedOpenError.sshChannelCloseConfirmed = true
            }
          })
        }
        return
      }
      settled = true
      cleanup()
      if (abortRequested) {
        if (!error && value !== undefined) {
          rejectAfterClose(value)
        } else {
          reject(createSshOperationAbortError())
        }
        return
      }
      if (error) {
        reject(error)
        return
      }
      resolve(value as T)
    }
    if (signal?.aborted) {
      // No open is in flight yet, so failing fast leaks nothing.
      cleanup()
      reject(createSshOperationAbortError())
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      // Bound channel open itself; higher-level exec/SFTP timers begin only after callback.
      register(finish)
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
