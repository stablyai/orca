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
import { dirname } from 'node:path'
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

/** Orca's own bookkeeping: an unreadable or linked ledger starts empty (nothing shared is overwritten) and is rewritten. */
export function readClaudeProfileLedger(file: string): {
  ledger: ClaudeProfileLedger
  readable: boolean
} {
  const ledger: ClaudeProfileLedger = { version: 1, files: {}, keys: {} }
  try {
    if (lstatSync(file).isSymbolicLink()) {
      return { ledger, readable: false }
    }
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      return { ledger, readable: false }
    }
  }
  const result = readClaudeProfileObject(file)
  if (result.kind !== 'present') {
    return { ledger, readable: result.kind === 'absent' }
  }
  const { files, keys } = result.value
  if (files && typeof files === 'object') {
    for (const [key, value] of Object.entries(files)) {
      if (typeof value === 'string') {
        ledger.files[key] = value
      }
    }
  }
  if (keys && typeof keys === 'object') {
    for (const [surface, entries] of Object.entries(keys)) {
      if (!entries || typeof entries !== 'object') {
        continue
      }
      const values: Record<string, string> = {}
      for (const [key, value] of Object.entries(entries)) {
        if (typeof value === 'string') {
          values[key] = value
        }
      }
      ledger.keys[surface] = values
    }
  }
  return { ledger, readable: true }
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
  symlinkSync(canonical, target, platform === 'win32' ? 'junction' : 'dir')
  return 'linked'
}

export function syncClaudeProfileFile(
  source: string,
  target: string,
  surface: string,
  ledger: ClaudeProfileLedger
): ClaudeProfileSurfaceOutcome {
  let desired: string
  try {
    desired = readFileSync(source, 'utf8')
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
