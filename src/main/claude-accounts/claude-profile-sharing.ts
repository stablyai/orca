import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { readClaudeProfileObject } from './claude-profile-paths'
import type { ClaudeProfileSurfaceOutcome } from './claude-profile-report'

/** Keyed by surface name, not path, so another spelling of the same profile keeps its history. */
export type ClaudeProfileLedger = {
  version: 1
  files: Record<string, string>
  keys: Record<string, Record<string, string>>
}

function stringEntries(value: unknown): Record<string, string> {
  const entries: Record<string, string> = {}
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string') {
        entries[key] = entry
      }
    }
  }
  return entries
}

export function claudeProfileLedgerPath(profileHome: string): string {
  return join(profileHome, '.orca-profile.json')
}

export function writeClaudeProfileLedger(file: string, ledger: ClaudeProfileLedger): void {
  writeFileAtomically(file, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
}

/** Orca's own bookkeeping: an unreadable ledger starts empty, so nothing shared is overwritten. */
export function readClaudeProfileLedger(file: string): ClaudeProfileLedger {
  const ledger: ClaudeProfileLedger = { version: 1, files: {}, keys: {} }
  const result = readClaudeProfileObject(file)
  if (result.kind !== 'present') {
    return ledger
  }
  ledger.files = stringEntries(result.value.files)
  const keys = result.value.keys
  if (keys && typeof keys === 'object') {
    for (const [surface, entries] of Object.entries(keys)) {
      ledger.keys[surface] = stringEntries(entries)
    }
  }
  return ledger
}

export function linkClaudeProfileDirectory(
  source: string,
  target: string,
  platform: NodeJS.Platform
): ClaudeProfileSurfaceOutcome {
  let canonical: string
  try {
    canonical = realpathSync(source)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return 'absent'
    }
    throw error
  }
  let entry: ReturnType<typeof lstatSync> | undefined
  try {
    entry = lstatSync(target)
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
  }
  if (entry?.isSymbolicLink()) {
    try {
      return realpathSync(target) === canonical ? 'unchanged' : 'user-owned'
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        throw error
      }
      unlinkSync(target)
    }
  } else if (entry) {
    if (!entry.isDirectory() || readdirSync(target).length > 0) {
      return 'user-owned'
    }
    rmdirSync(target)
  }
  mkdirSync(dirname(target), { recursive: true })
  // Why: link the path itself so a user who re-points their own link is followed.
  symlinkSync(source, target, platform === 'win32' ? 'junction' : 'dir')
  return 'linked'
}

export function syncClaudeProfileFile(
  source: string,
  target: string,
  surface: string,
  ledger: ClaudeProfileLedger,
  render: (sourceText: string) => string = (sourceText) => sourceText
): ClaudeProfileSurfaceOutcome {
  let desired: string
  try {
    desired = render(readFileSync(source, 'utf8'))
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return 'absent'
    }
    throw error
  }
  const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
  try {
    if (lstatSync(target).isSymbolicLink()) {
      return 'user-owned'
    }
    const current = hash(readFileSync(target, 'utf8'))
    if (current === hash(desired)) {
      ledger.files[surface] = current
      return 'unchanged'
    }
    if (ledger.files[surface] !== current) {
      return 'user-owned'
    }
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
  }
  writeFileAtomically(target, desired, { mode: 0o600 })
  ledger.files[surface] = hash(desired)
  return 'synced'
}

/** Returns the keys it changed in `target`. */
export function mergeClaudeProfileKeys(
  target: Record<string, unknown>,
  desired: Record<string, unknown>,
  written: Record<string, string>
): string[] {
  const changed: string[] = []
  for (const [key, value] of Object.entries(desired)) {
    const serialized = JSON.stringify(value)
    const current = key in target ? JSON.stringify(target[key]) : undefined
    if (current !== serialized && current !== undefined && written[key] !== current) {
      continue
    }
    if (current !== serialized) {
      target[key] = value
      changed.push(key)
    }
    written[key] = serialized
  }
  return changed
}

/**
 * A key the default home dropped leaves the profile when the profile still holds what Orca last
 * shared; a value changed inside the profile stays. Callers skip this when the source was unreadable.
 */
export function dropClaudeProfileKeys(
  target: Record<string, unknown>,
  desired: Record<string, unknown>,
  written: Record<string, string>
): string[] {
  const dropped: string[] = []
  for (const key of Object.keys(written)) {
    if (key in desired) {
      continue
    }
    if (!(key in target)) {
      delete written[key]
    } else if (JSON.stringify(target[key]) === written[key]) {
      delete target[key]
      delete written[key]
      dropped.push(key)
    }
  }
  return dropped
}
