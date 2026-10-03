import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'

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
