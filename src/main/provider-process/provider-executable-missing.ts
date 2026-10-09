import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

// A provider CLI that is not installed, told apart from every other failed start: its own spawn
// reported ENOENT. Typed where the spawn is observed, then read wherever the start is worded.

/** ENOENT for the command itself; an existing executable can fail because its interpreter is missing. */
export function isMissingProviderExecutable(error: unknown, command: string): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    error.code !== 'ENOENT'
  ) {
    return false
  }
  if ('path' in error && error.path !== command) {
    return false
  }
  return !isAbsolute(command) || !existsSync(command)
}

/** Marks the error a connection ended with when its provider's executable was missing. */
export function withMissingProviderExecutable<TError extends Error>(error: TError): TError {
  return Object.assign(error, { providerExecutableMissing: true })
}

/** Follows `cause` and aggregated errors, since the acquisition errors wrap what a connection threw. */
export function providerExecutableMissing(error: unknown, depth = 0): boolean {
  if (depth >= 6 || !(error instanceof Error)) {
    return false
  }
  if ('providerExecutableMissing' in error && error.providerExecutableMissing === true) {
    return true
  }
  if (
    error instanceof AggregateError &&
    error.errors.some((inner) => providerExecutableMissing(inner, depth + 1))
  ) {
    return true
  }
  return providerExecutableMissing(error.cause, depth + 1)
}
