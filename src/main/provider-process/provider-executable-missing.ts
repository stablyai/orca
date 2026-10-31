import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { findInErrorChain } from './provider-error-chain'

/** What a spawn's ENOENT proves absent: the provider's executable or the folder it ran in. */
export type ProviderSpawnAbsence = 'executable' | 'launchFolder'

function folderGone(cwd: string): boolean {
  try {
    statSync(cwd)
    return false
  } catch (error) {
    // Only absence blames the folder; a permission or I/O failure leaves the CLI to blame.
    return isDefinitiveAbsence(error)
  }
}

/**
 * ENOENT for the command itself; an existing executable can fail because its interpreter is
 * missing. Node names the command when the cwd is gone too, so one stat of the cwd tells them
 * apart. It runs where the spawn ran, against the cwd that spawn was given.
 */
export function providerSpawnAbsence(
  error: unknown,
  command: string,
  cwd?: string
): ProviderSpawnAbsence | null {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    error.code !== 'ENOENT'
  ) {
    return null
  }
  if ('path' in error && error.path !== command) {
    return null
  }
  if (cwd !== undefined && folderGone(cwd)) {
    return 'launchFolder'
  }
  return !isAbsolute(command) || !existsSync(command) ? 'executable' : null
}

export function isMissingProviderExecutable(
  error: unknown,
  command: string,
  cwd?: string
): boolean {
  return providerSpawnAbsence(error, command, cwd) === 'executable'
}

export function withMissingProviderExecutable<TError extends Error>(error: TError): TError {
  return Object.assign(error, { providerExecutableMissing: true })
}

export function withProviderSpawnAbsence<TError extends Error>(
  error: TError,
  absence: ProviderSpawnAbsence | null
): TError {
  if (absence === 'executable') {
    return withMissingProviderExecutable(error)
  }
  return absence === 'launchFolder'
    ? Object.assign(error, { providerLaunchFolderMissing: true })
    : error
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

/** A spawn ENOENT blamed on the CLI or its folder: a start failure, never a provider exit. */
export function providerSpawnAbsent(error: unknown): boolean {
  return providerExecutableMissing(error) || providerLaunchFolderMissing(error)
}

/** The provider's working folder was gone when it spawned, e.g. a deleted worktree. */
export function providerLaunchFolderMissing(error: unknown): boolean {
  return (
    findInErrorChain(error, (inner) =>
      'providerLaunchFolderMissing' in inner && inner.providerLaunchFolderMissing === true
        ? true
        : undefined
    ) ?? false
  )
}
