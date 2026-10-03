import { trackSshConnectionChannelLifetime } from './ssh-connection-channel-lifetime'
import { CONNECT_TIMEOUT_MS, createSshOperationAbortError } from './ssh-connection-utils'
import type { SshConnectionWorkLedger } from './ssh-connection-work-ledger'
import { isSshSessionLimitError } from './ssh-session-limit-error'

type SshChannelOpenWork = ReturnType<SshConnectionWorkLedger['beginChannelOpen']>

// Upper bound on waiting for an aborted channel's open/close to settle before rejecting anyway.
const ABORTED_CHANNEL_CLOSE_GRACE_MS = 5_000

// Why: MaxSessions servers can transiently refuse a channel open; a refused open never ran the command, so retry is safe.
const SESSION_LIMIT_OPEN_RETRIES = 4
const SESSION_LIMIT_OPEN_RETRY_DELAY_MS = 150

export async function openSshSessionChannelWithRetry<T>(
  open: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < SESSION_LIMIT_OPEN_RETRIES; attempt++) {
    if (attempt > 0) {
      // Why: an abort must release the backoff immediately, not after it.
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

/**
 * Waits for an ssh2 channel open, bounded by CONNECT_TIMEOUT_MS and an abort grace. The channel,
 * late ones included, stays on `work` until it physically closes.
 */
export function waitForSshChannelOpen<T>(
  work: SshChannelOpenWork,
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
      work.markUnverifiable(error)
      if (!trackRemoteCommandTermination) {
        return error
      }
      unconfirmedOpenError = Object.assign(error, { sshChannelCloseConfirmed: false })
      return unconfirmedOpenError
    }
    // Why: an in-flight open holds a MaxSessions slot; reject the caller now, then settle from the open callback once the late channel closes.
    let abortRequested = false
    let abortDeadlineTimer: NodeJS.Timeout | undefined
    const cleanup = (): void => {
      clearTimeout(timer)
      clearTimeout(abortDeadlineTimer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      abortRequested = true
      // Why: a hung socket may never invoke the open callback; bound the aborted caller's wait instead of pinning it for CONNECT_TIMEOUT_MS.
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
          abortRequested ? createSshOperationAbortError() : new Error(timeoutMessage)
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
      // Why: ssh2 withholds CHANNEL_CLOSE while discarded exec streams remain unread, and teardown errors have no other owner.
      emitter.resume?.()
      emitter.stderr?.resume?.()
      try {
        cleanupLateValue?.(value)
      } catch {
        /* best effort */
      }
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
      // Why: bounded so a remote that never confirms the close can't hang the aborted operation forever.
      const closeGraceTimer = setTimeout(done, ABORTED_CHANNEL_CLOSE_GRACE_MS)
      if (typeof emitter.once === 'function') {
        emitter.once('close', confirmAndDone)
      }
      // Why: ssh2 withholds 'close' until the channel's streams are drained; nobody else will read this discarded channel.
      discardLateValue(value)
      if (typeof emitter.once !== 'function') {
        done()
      }
    }
    const finish = (error: Error | undefined, value?: T): void => {
      // Late channels stay tracked until physical close, after the caller has given up.
      if (!error && value !== undefined) {
        trackSshConnectionChannelLifetime(work, value, onUnhandledError)
      } else {
        work.close(error)
      }
      if (settled) {
        // Why: ssh2 can invoke the open callback after our timeout rejected; close that late channel so it isn't left open with no owner.
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
      work.close()
      reject(createSshOperationAbortError())
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      // Why: higher-level channel timers start only after ssh2's open callback; a stale SSH socket can otherwise keep exec/sftp stuck.
      register(finish)
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
