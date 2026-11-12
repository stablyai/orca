import { isDeepStrictEqual } from 'node:util'
import {
  CLAUDE_SETTINGS_PERMISSION_LISTS,
  CLAUDE_SETTINGS_SCALAR_KEYS,
  type ClaudeSettingsPayload
} from '../../../shared/agent-config-sync/agent-config-sync-contract'

/** What this computer last wrote into the sandbox's settings.json: per scalar key the value, per
 * permission list the rules it added. Nothing else in the file is ever its to change. */
export type ClaudeSettingsLedger = {
  scalars: Partial<Record<(typeof CLAUDE_SETTINGS_SCALAR_KEYS)[number], unknown>>
  permissions: Partial<Record<(typeof CLAUDE_SETTINGS_PERMISSION_LISTS)[number], string[]>>
}

type Json = Record<string, unknown>
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export type SettingsMergeResult =
  | { kind: 'merged'; text: string | null; ledger: ClaudeSettingsLedger }
  /** settings.json in the sandbox isn't a JSON object: it's left exactly as it is. */
  | { kind: 'unreadable' }

function parse(text: string | null): Json | null {
  if (text === null || text.trim() === '') {
    return {}
  }
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

/** Apply `desired` (empty to remove everything this computer added). Per scalar: set it unless the
 * sandbox changed it since; drop it if no longer wanted and still ours. Per permission list: add
 * new rules, remove only rules this computer added and no longer wants. */
export function mergeClaudeSettings(
  currentText: string | null,
  desired: ClaudeSettingsPayload,
  ledger: ClaudeSettingsLedger
): SettingsMergeResult {
  const current = parse(currentText)
  if (!current) {
    return { kind: 'unreadable' }
  }
  const next: Json = structuredClone(current)
  const nextLedger: ClaudeSettingsLedger = { scalars: {}, permissions: {} }

  for (const key of CLAUDE_SETTINGS_SCALAR_KEYS) {
    const want = desired[key]
    const have = next[key]
    const wrote = ledger.scalars[key]
    const ours = key in ledger.scalars && isDeepStrictEqual(have, wrote)
    if (want === undefined) {
      if (ours) {
        delete next[key]
      }
      continue
    }
    if (have === undefined || ours) {
      next[key] = want
      nextLedger.scalars[key] = want
    }
    // Otherwise the sandbox set its own value: it wins, and stops being ours.
  }

  const permissions: Json = isRecord(next.permissions) ? { ...next.permissions } : {}
  for (const list of CLAUDE_SETTINGS_PERMISSION_LISTS) {
    const existing = permissions[list]
    const have: string[] = Array.isArray(existing)
      ? existing.filter((rule): rule is string => typeof rule === 'string')
      : []
    const want = new Set(desired.permissions?.[list] ?? [])
    const added = new Set(ledger.permissions[list] ?? [])
    // Ours and no longer wanted: gone. Everything the sandbox added stays.
    const kept = have.filter((rule) => !(added.has(rule) && !want.has(rule)))
    const keptSet = new Set(kept)
    const fresh = [...want].filter((rule) => !keptSet.has(rule))
    const result = [...kept, ...fresh]
    // Rules this computer is responsible for: the ones it added before and still wants, plus new.
    const responsible = [...want].filter((rule) => added.has(rule) || !have.includes(rule))
    if (responsible.length > 0) {
      nextLedger.permissions[list] = responsible
    }
    if (result.length > 0) {
      permissions[list] = result
    } else if (Array.isArray(permissions[list]) || list in permissions) {
      delete permissions[list]
    }
  }
  if (Object.keys(permissions).length > 0) {
    next.permissions = permissions
  } else {
    delete next.permissions
  }

  const unchanged = isDeepStrictEqual(next, current)
  return {
    kind: 'merged',
    text: unchanged ? null : `${JSON.stringify(next, null, 2)}\n`,
    ledger: nextLedger
  }
}
