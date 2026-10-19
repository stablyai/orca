import { createGhLogicalLifetime } from '../../../git/command-runner/gh-capture-lifetime'
import { createCheckDetailsAbortError, waitForCheckDetailsResolution } from './check-details-abort'

export function createCheckDetailsAdmissionLifetime(release: () => void): {
  retainUntil: (terminated: Promise<void>) => void
  finish: () => void
} {
  let pending = 0
  let finished = false
  let released = false
  const releaseIfFinished = (): void => {
    if (!finished || pending !== 0 || released) {
      return
    }
    released = true
    release()
  }
  return {
    retainUntil: (terminated) => {
      pending += 1
      void terminated.then(() => {
        pending -= 1
        releaseIfFinished()
      })
    },
    finish: () => {
      finished = true
      releaseIfFinished()
    }
  }
}

export function runCheckDetailsCall<T>(
  run: (hooks: ReturnType<typeof createGhLogicalLifetime>['hooks']) => Promise<T>,
  signal: AbortSignal,
  retainUntil: (terminated: Promise<void>) => void
): { result: Promise<T>; terminated: Promise<void> } {
  const lifetime = createGhLogicalLifetime()
  retainUntil(lifetime.terminated)
  const operation = Promise.resolve()
    .then(() => {
      if (signal.aborted) {
        throw createCheckDetailsAbortError()
      }
      return run(lifetime.hooks)
    })
    .then(
      (value) => {
        lifetime.seal()
        return value
      },
      (error: unknown) => {
        lifetime.seal()
        throw error
      }
    )
  return {
    result: waitForCheckDetailsResolution(operation, signal),
    terminated: lifetime.terminated
  }
}
