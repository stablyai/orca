import type { Readable } from 'node:stream'
import { detachProviderStreamErrorHandler } from './provider-stdio-error-boundary'

export type ProviderReceiveDisposition =
  | { state: 'retained' }
  | { state: 'complete' }
  | { state: 'failed'; error: unknown }

export const PROVIDER_INPUT_EXIT_GRACE_MS = 1_000

/** Own input until EOF; process death only bounds acquisition of future bytes. */
export function createProviderSourceCompletion(
  input: Readable,
  handlers: {
    data: (chunk: string) => void
    end: (natural: boolean) => void
    error: (error: Error) => void
    draining?: () => void
  }
): {
  readonly ending: boolean
  readonly done: Promise<void>
  finish: () => Promise<void>
  dispose: () => void
} {
  let ending = false
  let sealed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const completion = Promise.withResolvers<void>()
  // Fault observers may close a process before its owner joins input completion.
  void completion.promise.catch(() => {})
  const detach = (): void => {
    clearTimeout(timer)
    input.removeListener('data', data)
    input.removeListener('end', end)
    input.removeListener('close', close)
    detachProviderStreamErrorHandler(input, error)
  }
  const transferHeld = (): void => {
    input.pause()
    input.removeListener('data', data)
    handlers.draining?.()
    for (let chunk = input.read(); chunk !== null; chunk = input.read()) {
      handlers.data(chunk)
    }
  }
  const fail = (cause: unknown): void => {
    if (sealed) {
      return
    }
    const failure = cause instanceof Error ? cause : new Error(String(cause))
    sealed = true
    detach()
    try {
      transferHeld()
    } catch {
      // Keep the original source failure while preserving the received prefix.
    }
    completion.reject(failure)
    handlers.error(failure)
  }
  const seal = (natural: boolean): void => {
    if (sealed) {
      return
    }
    sealed = true
    detach()
    try {
      handlers.end(natural)
      completion.resolve()
    } catch (cause) {
      const failure = cause instanceof Error ? cause : new Error(String(cause))
      completion.reject(failure)
      handlers.error(failure)
    }
  }
  const data = (chunk: string): void => {
    try {
      handlers.data(chunk)
    } catch (cause) {
      fail(cause)
    }
  }
  const end = (): void => seal(true)
  const close = (): void => {
    if (sealed) {
      return
    }
    try {
      transferHeld()
      seal(input.readableEnded)
    } catch (cause) {
      fail(cause)
    }
  }
  const error = (cause: Error): void => fail(cause)
  input.setEncoding('utf8')
  input.on('data', data)
  input.on('end', end)
  input.on('close', close)
  input.on('error', error)
  return {
    get ending() {
      return ending || sealed
    },
    done: completion.promise,
    finish: () => {
      if (!ending && !sealed) {
        ending = true
        try {
          handlers.draining?.()
          input.resume()
          if (input.readableEnded || input.destroyed) {
            transferHeld()
            seal(input.readableEnded)
          } else {
            timer = setTimeout(() => {
              try {
                transferHeld()
                seal(input.readableEnded)
              } catch (cause) {
                fail(cause)
              }
            }, PROVIDER_INPUT_EXIT_GRACE_MS)
            timer.unref()
          }
        } catch (cause) {
          fail(cause)
        }
      }
      return completion.promise
    },
    dispose: () => {
      if (!sealed) {
        sealed = true
        detach()
        try {
          transferHeld()
        } catch (cause) {
          completion.reject(cause)
          throw cause
        }
        completion.resolve()
      }
    }
  }
}
