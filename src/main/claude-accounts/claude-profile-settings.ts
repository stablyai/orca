import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { writeFileAtomically } from '../filesystem/atomic-file-publication'
import { readClaudeProfileObject } from './claude-profile-paths'
import { lstatIfPresent } from './claude-profile-prompt-history'
import {
  ClaudeProfileSurfaceError,
  type ClaudeProfileSurfaceOutcome
} from './claude-profile-report'

// Digests, not values, so proxy keys in settings are not stored a second time.
function digestSettings(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
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
  const lastSync = readClaudeProfileObject(record)
  const digests = digestSettings(defaults)
  // Without a record the default home wins whole, as every sync did before records.
  let settings = { ...defaults }
  if (current.kind === 'present' && lastSync.kind === 'present') {
    const last = lastSync.value
    settings = { ...current.value }
    for (const key of new Set([...Object.keys(digests), ...Object.keys(last)])) {
      if (last[key] === digests[key]) {
        continue
      }
      if (Object.hasOwn(defaults, key)) {
        settings[key] = defaults[key]
      } else {
        delete settings[key]
      }
    }
  }
  const unchanged =
    current.kind === 'present'
      ? JSON.stringify(settings) === JSON.stringify(current.value)
      : current.kind === 'absent' && input.kind === 'absent'
  let outcome: ClaudeProfileSurfaceOutcome = 'unchanged'
  if (!unchanged) {
    writeFileAtomically(target, `${JSON.stringify(settings, null, 2)}\n`, {
      mode: input.kind === 'present' ? statSync(source).mode & 0o777 : 0o600
    })
    outcome = 'synced'
  }
  if (
    JSON.stringify(digests) !== JSON.stringify(lastSync.kind === 'present' ? lastSync.value : null)
  ) {
    writeFileAtomically(record, `${JSON.stringify(digests)}\n`, { mode: 0o600 })
  }
  return outcome
}
