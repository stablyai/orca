import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { JsonTextStructureCapacityError } from '../../../../shared/json-stream/json-text-structure-limit'
import { NodeFileReadTooLargeError } from '../../../../shared/file-content/node-bounded-file-reader'
import { join } from 'node:path'
import {
  MAX_AGENT_STATE_FILE_BYTES,
  readAgentStateFileSync,
  readAgentStateJsonFileSync
} from '../agent-state-file-reader'
import { writeFileAtomically } from '../../../filesystem/atomic-file-publication'
import {
  EMPTY_GUEST_CARRY_FORWARD,
  isGuestCarryForwardEmpty,
  type CodexGuestCarriedRegistration,
  type CodexGuestCarryForward
} from './codex-config-guest-carry-forward'
import type { CodexRegistrationPromotion } from './config-plugin-registration-promotion'

const SETTINGS_BASELINE_FILE = '.orca-config-settings-baseline.json'

export type CodexSettingsConflict = {
  runtime: string | null
  system: string | null
}

export type CodexSettingsBaseline = {
  settings: ReadonlyMap<string, string | null>
  conflicts: ReadonlyMap<string, CodexSettingsConflict>
  /** Absent registrations were never mirrored, so runtime-only tables count as additions. */
  registrations: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** MCP server names the last mirror copied from the canonical source. */
  mcpServers: ReadonlySet<string>
  mcpServerRoot: boolean
  /** False for baselines from before Orca recorded which plugin tables it mirrored. */
  tracksRegistrations?: boolean
  /** Set once a WSL distro config regenerated this home; absent on homes an older Orca mirrored. */
  guestCarryForward?: CodexGuestCarryForward
  /** Set once a pass found ~/.codex outside any WSL distro, so clean passes need not resolve it again. */
  nativeSource?: boolean
}

type StoredGuestCarryForward = {
  settings?: Record<string, { raw: string; system: string | null }>
  registrations?: CodexGuestCarriedRegistration[]
}

type StoredSettingsBaseline = {
  version: 1 | 2 | 3
  settings: Record<string, string | null>
  conflicts?: Record<string, CodexSettingsConflict>
  registrations?: Record<string, Record<string, string>>
  mcpServers?: string[]
  mcpServerRoot?: boolean
  guestCarryForward?: StoredGuestCarryForward
  nativeSource?: boolean
}

/** Unreadable baselines stall the mirror; absent or invalid baselines can be rebuilt. */
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
    const settings = new Map(
      Object.entries(parsed.settings).filter((entry): entry is [string, string | null] => {
        return typeof entry[1] === 'string' || entry[1] === null
      })
    )
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
      registrations: readStoredRegistrations(parsed.registrations),
      mcpServers: readStoredMcpServers(parsed.mcpServers),
      // Older mirrors owned the whole MCP root; retain that removal policy for one pass.
      mcpServerRoot: parsed.mcpServers === undefined || parsed.mcpServerRoot === true,
      // Version 3 came with registration tracking.
      tracksRegistrations: parsed.version === 3,
      nativeSource: parsed.nativeSource === true,
      ...(parsed.guestCarryForward !== undefined && {
        guestCarryForward: readStoredGuestCarryForward(parsed.guestCarryForward)
      })
    }
  } catch (error) {
    return isDefinitiveAbsence(error) || isRebuildableBaselineError(error) ? null : 'unreadable'
  }
}

// A malformed record still marks the home as regenerated, so nothing is carried twice.
function readStoredGuestCarryForward(stored: unknown): CodexGuestCarryForward {
  if (!isRecord(stored)) {
    return EMPTY_GUEST_CARRY_FORWARD
  }
  const { settings, registrations } = stored
  return {
    settings: new Map(
      Object.entries(isRecord(settings) ? settings : {}).filter(
        (entry): entry is [string, { raw: string; system: string | null }] =>
          isRecord(entry[1]) &&
          typeof entry[1].raw === 'string' &&
          (typeof entry[1].system === 'string' || entry[1].system === null)
      )
    ),
    registrations: (Array.isArray(registrations) ? registrations : []).filter(
      (entry: unknown): entry is CodexGuestCarriedRegistration =>
        isRecord(entry) &&
        (typeof entry.system === 'string' || entry.system === null) &&
        (typeof entry.identity === 'string' || entry.identity === null) &&
        isStoredRegistrationPromotion(entry.promotion)
    )
  }
}

function isStoredRegistrationPromotion(value: unknown): value is CodexRegistrationPromotion {
  if (!isRecord(value) || typeof value.key !== 'string') {
    return false
  }
  return value.kind === 'append'
    ? typeof value.block === 'string'
    : value.kind === 'field' &&
        typeof value.field === 'string' &&
        (typeof value.raw === 'string' || value.raw === null)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readStoredMcpServers(stored: string[] | undefined): ReadonlySet<string> {
  return new Set((stored ?? []).filter((name): name is string => typeof name === 'string'))
}

function readStoredRegistrations(
  stored: Record<string, Record<string, string>> | undefined
): Map<string, ReadonlyMap<string, string>> {
  const registrations = new Map<string, ReadonlyMap<string, string>>()
  for (const [key, fields] of Object.entries(stored ?? {})) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      continue
    }
    registrations.set(
      key,
      new Map(
        Object.entries(fields).filter((entry): entry is [string, string] => {
          return typeof entry[1] === 'string'
        })
      )
    )
  }
  return registrations
}

/** Invalid or oversized derived state can be rebuilt after a successful read. */
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
  const file: StoredSettingsBaseline = {
    version: 3,
    settings: Object.fromEntries(baseline.settings),
    mcpServers: [...baseline.mcpServers]
  }
  if (baseline.conflicts.size > 0) {
    file.conflicts = Object.fromEntries(baseline.conflicts)
  }
  if (baseline.registrations.size > 0) {
    file.registrations = Object.fromEntries(
      [...baseline.registrations].map(([key, fields]) => [key, Object.fromEntries(fields)])
    )
  }
  if (baseline.mcpServerRoot) {
    file.mcpServerRoot = true
  }
  if (baseline.guestCarryForward) {
    file.guestCarryForward = {
      settings: Object.fromEntries(baseline.guestCarryForward.settings),
      registrations: [...baseline.guestCarryForward.registrations]
    }
  }
  if (baseline.nativeSource) {
    file.nativeSource = true
  }
  const baselinePath = getCodexSettingsBaselinePath(runtimeHomePath)
  const serialized = `${JSON.stringify(file, null, 2)}\n`
  // Kept values live only here; keep the last readable file rather than write one the reader drops.
  if (
    baseline.guestCarryForward &&
    !isGuestCarryForwardEmpty(baseline.guestCarryForward) &&
    Buffer.byteLength(serialized) > MAX_AGENT_STATE_FILE_BYTES
  ) {
    throw new Error('Codex settings baseline with kept values exceeds the readable size')
  }
  let existing: string | null = null
  try {
    existing = readAgentStateFileSync(baselinePath)
  } catch (error) {
    // Preserve state that could not be read; only absent or invalid state can be replaced.
    if (!isDefinitiveAbsence(error) && !isRebuildableBaselineError(error)) {
      throw error
    }
  }
  // Avoid disk metadata churn during repeated launch preparation.
  if (existing === serialized) {
    return
  }
  // Atomic: kept tab edits live only here, so a cut-off write must leave the previous file whole.
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
