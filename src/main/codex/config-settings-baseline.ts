import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { JsonTextStructureCapacityError } from '../../shared/json-text-structure-limit'
import { NodeFileReadTooLargeError } from '../../shared/node-bounded-file-reader'
import { join } from 'node:path'
import {
  MAX_AGENT_STATE_FILE_BYTES,
  readAgentStateFileSync,
  readAgentStateJsonFileSync
} from '../agent-state-file-reader'
import { writeFileAtomically } from '../codex-accounts/fs-utils'

const SETTINGS_BASELINE_FILE = '.orca-config-settings-baseline.json'

export type CodexSettingsConflict = {
  runtime: string | null
  system: string | null
}

export type CodexSettingsBaseline = {
  settings: ReadonlyMap<string, string | null>
  conflicts: ReadonlyMap<string, CodexSettingsConflict>
  knownPromotedKeys: ReadonlySet<string>
  sourceIsAuthoritative: boolean
  tracksAllOrdinarySettings: boolean
}

type StoredSettingsBaseline = {
  version: 1 | 2 | 3
  settings: Record<string, string | null>
  conflicts?: Record<string, CodexSettingsConflict>
  knownPromotedKeys?: string[]
  sourceAuthority?: 'mirrored'
}

/**
 * Why callers need three answers, not two: without a readable baseline,
 * promotion cannot distinguish an in-Codex edit from Orca's last mirror. An
 * unreadable baseline must stall that mirror; absent and unparseable still map
 * to `absent` because rebuilding those is the intent.
 */
export type CodexSettingsBaselineObservation =
  | { kind: 'present'; baseline: CodexSettingsBaseline }
  | { kind: 'absent' }
  | { kind: 'indeterminate' }

export function observeCodexSettingsBaseline(
  runtimeHomePath: string
): CodexSettingsBaselineObservation {
  const baselinePath = getCodexSettingsBaselinePath(runtimeHomePath)
  const baseline = readParsedCodexSettingsBaseline(baselinePath)
  if (baseline === 'unreadable') {
    return { kind: 'indeterminate' }
  }
  return baseline ? { kind: 'present', baseline } : { kind: 'absent' }
}

/** Absent and unreadable both collapse to `null`; use the observation to tell them apart. */
export function readCodexSettingsBaseline(runtimeHomePath: string): CodexSettingsBaseline | null {
  const observation = observeCodexSettingsBaseline(runtimeHomePath)
  return observation.kind === 'present' ? observation.baseline : null
}

function readParsedCodexSettingsBaseline(
  baselinePath: string
): CodexSettingsBaseline | null | 'unreadable' {
  try {
    const parsed: unknown = readAgentStateJsonFileSync(baselinePath)
    if (!isStoredSettingsBaseline(parsed)) {
      return null
    }
    if (parsed.version === 3 && !hasStrictV3Members(parsed)) {
      return null
    }
    const settings = new Map<string, string | null>()
    for (const [key, raw] of Object.entries(parsed.settings)) {
      if (typeof raw === 'string' || raw === null) {
        settings.set(key, raw)
      }
    }
    const conflicts = new Map<string, CodexSettingsConflict>()
    for (const [key, conflict] of Object.entries(parsed.conflicts ?? {})) {
      if (
        conflict &&
        (typeof conflict.runtime === 'string' || conflict.runtime === null) &&
        (typeof conflict.system === 'string' || conflict.system === null)
      ) {
        conflicts.set(key, conflict)
      }
    }
    return {
      settings,
      conflicts,
      knownPromotedKeys: new Set(parsed.knownPromotedKeys ?? []),
      sourceIsAuthoritative: parsed.sourceAuthority === 'mirrored',
      tracksAllOrdinarySettings: parsed.version === 3
    }
  } catch (error) {
    // Why: invalid baseline state is still `null` — resetting it is the intent,
    // and only a read that FAILED must be preserved.
    return isDefinitiveAbsence(error) || isRebuildableBaselineError(error) ? null : 'unreadable'
  }
}

/** Why: known-present baseline state outside its parse/capacity contract is rebuildable, not unreadable. */
function isRebuildableBaselineError(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    error instanceof JsonTextStructureCapacityError ||
    error instanceof NodeFileReadTooLargeError
  )
}

export function writeCodexSettingsBaseline(
  runtimeHomePath: string,
  baseline: CodexSettingsBaseline
): void {
  const file = buildStoredSettingsBaseline(baseline)
  const baselinePath = getCodexSettingsBaselinePath(runtimeHomePath)
  const serialized = serializeBaseline(file)
  let existing: string | null = null
  try {
    existing = readAgentStateFileSync(baselinePath)
  } catch (error) {
    // Why: only absence or known-invalid derived state may authorize replacement.
    if (!isDefinitiveAbsence(error) && !isRebuildableBaselineError(error)) {
      throw error
    }
  }
  // Why: launch prep runs repeatedly; byte-identical baselines should not churn disk metadata.
  if (existing === serialized) {
    return
  }
  writeFileAtomically(baselinePath, serialized, { mode: 0o600 })
}

export function getCodexSettingsBaselinePath(runtimeHomePath: string): string {
  return join(runtimeHomePath, SETTINGS_BASELINE_FILE)
}

function isStoredSettingsBaseline(value: unknown): value is StoredSettingsBaseline {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const candidate = value as Partial<StoredSettingsBaseline>
  return (
    (candidate.version === 1 || candidate.version === 2 || candidate.version === 3) &&
    !!candidate.settings &&
    typeof candidate.settings === 'object' &&
    !Array.isArray(candidate.settings)
  )
}

function hasStrictV3Members(baseline: StoredSettingsBaseline): boolean {
  if (
    baseline.sourceAuthority !== 'mirrored' ||
    !Array.isArray(baseline.knownPromotedKeys) ||
    (baseline.conflicts !== undefined &&
      (!baseline.conflicts ||
        typeof baseline.conflicts !== 'object' ||
        Array.isArray(baseline.conflicts))) ||
    baseline.knownPromotedKeys.some(
      (key) => typeof key !== 'string' || !isStoredStructuredKey(key)
    ) ||
    new Set(baseline.knownPromotedKeys).size !== baseline.knownPromotedKeys.length
  ) {
    return false
  }
  if (
    Object.entries(baseline.settings).some(
      ([key, raw]) => !isStoredStructuredKey(key) || (typeof raw !== 'string' && raw !== null)
    )
  ) {
    return false
  }
  return Object.entries(baseline.conflicts ?? {}).every(
    ([key, conflict]) =>
      !Object.hasOwn(baseline.settings, key) &&
      isStoredStructuredKey(key) &&
      isCodexSettingsConflict(conflict)
  )
}

function isStoredStructuredKey(key: string): boolean {
  return /^(?:[A-Za-z0-9_-]+|tui\.[A-Za-z0-9_-]+)$/.test(key)
}

function isCodexSettingsConflict(value: unknown): value is CodexSettingsConflict {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const conflict = value as Partial<CodexSettingsConflict>
  return (
    (typeof conflict.runtime === 'string' || conflict.runtime === null) &&
    (typeof conflict.system === 'string' || conflict.system === null)
  )
}

function buildStoredSettingsBaseline(baseline: CodexSettingsBaseline): StoredSettingsBaseline {
  const preferred: StoredSettingsBaseline = {
    // A complete ordinary-key snapshot is only authoritative when it came
    // from a readable system mirror; otherwise v2 keeps absence ambiguous.
    version: baseline.tracksAllOrdinarySettings && baseline.sourceIsAuthoritative ? 3 : 2,
    settings: Object.fromEntries(baseline.settings)
  }
  if (baseline.conflicts.size > 0) {
    preferred.conflicts = Object.fromEntries(baseline.conflicts)
  }
  if (baseline.sourceIsAuthoritative) {
    preferred.sourceAuthority = 'mirrored'
  }
  if (preferred.version === 3) {
    preferred.knownPromotedKeys = [...baseline.knownPromotedKeys]
  }
  if (fitsBaselineReader(preferred)) {
    return preferred
  }
  return buildBoundedLegacyBaseline(baseline)
}

function buildBoundedLegacyBaseline(baseline: CodexSettingsBaseline): StoredSettingsBaseline {
  const fallback: StoredSettingsBaseline = { version: 2, settings: {} }
  if (baseline.sourceIsAuthoritative) {
    fallback.sourceAuthority = 'mirrored'
  }
  if (baseline.conflicts.size > 0) {
    fallback.conflicts = Object.fromEntries(baseline.conflicts)
  }
  if (!fitsBaselineReader(fallback)) {
    throw new NodeFileReadTooLargeError(
      Buffer.byteLength(serializeBaseline(fallback), 'utf-8'),
      MAX_AGENT_STATE_FILE_BYTES
    )
  }
  for (const key of baseline.knownPromotedKeys) {
    if (!baseline.settings.has(key)) {
      continue
    }
    fallback.settings[key] = baseline.settings.get(key) ?? null
    if (!fitsBaselineReader(fallback)) {
      delete fallback.settings[key]
    }
  }
  return fallback
}

function fitsBaselineReader(file: StoredSettingsBaseline): boolean {
  return Buffer.byteLength(serializeBaseline(file), 'utf-8') <= MAX_AGENT_STATE_FILE_BYTES
}

function serializeBaseline(file: StoredSettingsBaseline): string {
  return `${JSON.stringify(file, null, 2)}\n`
}
