import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import type { ClaudeProfileLaunchDescriptor } from './claude-profile-routing-owner'

export function publishClaudeProfilePointer(file: string, home: string | null): void {
  if (home !== null && (!isAbsolute(home) || /[\r\n\0]/.test(home))) {
    throw new Error('Invalid Claude profile pointer destination')
  }
  if (home !== null && !statSync(home).isDirectory()) {
    throw new Error('Selected Claude profile is not a directory')
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileAtomically(file, home ?? '', { mode: 0o600 })
}

export function withdrawClaudeProfilePointer(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch (error) {
    console.warn('[claude-profile] Could not withdraw the account pointer:', error)
  }
}

/** Only an explicitly published empty file selects System Default. */
export function readClaudeProfilePointer(file: string): string | null {
  const value = readFileSync(file, 'utf8')
  if (value === '') {
    return null
  }
  if (!isAbsolute(value) || /[\r\n\0]/.test(value) || !statSync(value).isDirectory()) {
    throw new Error('Selected Claude profile is unavailable; choose an account again')
  }
  return value
}

const POINTER_WRITE_FAILURES: Record<string, string> = {
  ENOSPC: 'the disk is full',
  EDQUOT: 'the disk is full',
  EACCES: 'permission was denied',
  EPERM: 'permission was denied',
  EROFS: 'the disk is read-only'
}

/** Plain text for a publish failure; a filesystem refusal never reaches the user as a raw code. */
export function describeClaudeProfilePublishError(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    const reason = POINTER_WRITE_FAILURES[error.code]
    return reason
      ? `Orca could not save the Claude account selection because ${reason}.`
      : 'Orca could not save the Claude account selection. Try again.'
  }
  return error instanceof Error ? error.message : String(error)
}

/** A host System Default publish whose pointer already says System Default changes nothing. */
export function claudeProfilePointerKeepsSystemDefault(
  descriptor: Pick<ClaudeProfileLaunchDescriptor, 'profile' | 'target' | 'pointerPath'> | undefined
): boolean {
  try {
    return (
      descriptor?.profile === null &&
      descriptor.target.runtime !== 'wsl' &&
      readClaudeProfilePointer(descriptor.pointerPath) === null
    )
  } catch {
    return false
  }
}
