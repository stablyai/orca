import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { findInErrorChain } from './provider-error-chain'

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

export function withMissingProviderExecutable<TError extends Error>(error: TError): TError {
  return Object.assign(error, { providerExecutableMissing: true })
}

export function providerExecutableMissing(error: unknown): boolean {
  return (
    findInErrorChain(error, (inner) =>
      'providerExecutableMissing' in inner && inner.providerExecutableMissing === true
        ? true
        : undefined
    ) ?? false
  )
}
