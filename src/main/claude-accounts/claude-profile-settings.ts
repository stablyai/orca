import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { getManagedScriptFileName, removeManagedHooks } from '../claude/hook-settings'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { readClaudeProfileObject } from './claude-profile-paths'
import { lstatIfPresent } from './claude-profile-prompt-history'
import {
  ClaudeProfileSurfaceError,
  type ClaudeProfileSurfaceOutcome
} from './claude-profile-report'

// Digests, not values, so proxy keys in settings are not stored a second time.
function digestSettings(value: Record<string, unknown>): Record<string, string> {
  // Ignore managed hooks because Orca installs them in both folders.
  const { config } = removeManagedHooks(value, getManagedScriptFileName())
  return Object.fromEntries(
    Object.entries(config).map(([key, entry]) => [
      key,
      createHash('sha256').update(JSON.stringify(entry)).digest('hex')
    ])
  )
}

/**
 * Apply each top-level key the default home changed since the last sync, and keep the rest of
 * the profile copy so settings Claude saves there itself, like `/model`, survive the next launch.
 */
export function syncClaudeProfileSettings(
  source: string,
  target: string,
  record: string
): ClaudeProfileSurfaceOutcome {
  if (lstatIfPresent(target)?.isSymbolicLink()) {
    return 'user-owned'
  }
  const input = readClaudeProfileObject(source)
  if (input.kind === 'unavailable') {
    throw new ClaudeProfileSurfaceError('unreadable', 'Personal Claude settings are unreadable')
  }
  const defaults = input.kind === 'present' ? input.value : {}
  const current = readClaudeProfileObject(target)
  // Replace a copy that does not parse, but never one that could not be read.
  if (current.kind === 'unavailable' && !(current.error instanceof SyntaxError)) {
    throw new ClaudeProfileSurfaceError('unreadable', 'Profile Claude settings are unreadable')
  }
  const synced = readClaudeProfileObject(record)
  // Without a record the default home wins whole, as every sync did before records.
  const last = current.kind === 'present' && synced.kind === 'present' ? synced.value : null
  const digests = digestSettings(defaults)
  const settings = current.kind === 'present' ? { ...current.value } : {}
  for (const key of new Set([...Object.keys(digests), ...Object.keys(last ?? settings)])) {
    if (last && last[key] === digests[key]) {
      continue
    }
    if (Object.hasOwn(defaults, key)) {
      settings[key] = defaults[key]
    } else {
      delete settings[key]
    }
  }
  let outcome: ClaudeProfileSurfaceOutcome = 'unchanged'
  if (
    current.kind === 'present'
      ? JSON.stringify(settings) !== JSON.stringify(current.value)
      : current.kind === 'unavailable' || input.kind === 'present'
  ) {
    writeFileAtomically(target, `${JSON.stringify(settings, null, 2)}\n`, {
      mode: input.kind === 'present' ? statSync(source).mode & 0o777 : 0o600
    })
    outcome = 'synced'
  }
  if (JSON.stringify(digests) !== JSON.stringify(synced.kind === 'present' ? synced.value : null)) {
    writeFileAtomically(record, `${JSON.stringify(digests)}\n`, { mode: 0o600 })
  }
  return outcome
}
