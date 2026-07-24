import type { AgentProviderSessionMetadata } from '../shared/agent-session-resume'
import type { AgentSessionOwnerBinding } from '../shared/agent-session-host-authority'
import { assertRelayPtyPersistenceFieldWithinLimit } from '../shared/pty-persistence-wire-limits'
import type { RelayPtyDurableLaunch, RelayPtyReplayTail } from '../shared/pty-revive-protocol'
import { clampUtf8TextTail } from '../shared/utf8-byte-limits'
import { assertJsonTextStructureWithinLimits } from '../shared/json-text-structure-limit'
import { stringifyJsonWithinByteLimit } from '../shared/node-bounded-json-stringify'
import {
  assertRelayPtyPersistenceEntrySize,
  assertV2EnvelopeRetainedBytes,
  assertExactKeys,
  normalizeRelayPtyPersistenceEntry,
  requiredRecord,
  requiredString,
  serializedRelayPtyPersistenceEntry
} from './pty-persistence-entry-normalization'

export const MAX_RELAY_PTY_PERSISTENCE_STATE_BYTES = 8 * 1024 * 1024
export const MAX_RELAY_PTY_PERSISTENCE_ENTRY_BYTES = 128 * 1024
export const MAX_RELAY_PTY_PERSISTENCE_RETAINED_BYTES = 6 * 1024 * 1024
export const MAX_RELAY_PTY_LOST_TAIL_BYTES = 100 * 1024
export const MAX_RELAY_PTY_ENV_DELETE_KEYS = 1_024

const PTY_PERSISTENCE_JSON_STRUCTURE_LIMITS = {
  structuralTokens: 131_072,
  nestingDepth: 8
} as const

export type RelayPtyIdentity = {
  paneKey?: string
  tabId?: string
}

export type RelayPtyPersistenceEntry = {
  id: string
  pid: number
  sourceIncarnationId?: string
  cols: number
  rows: number
  cwd: string
  paneKey?: string
  tabId?: string
  attachIdentity?: RelayPtyIdentity
  worktreeId?: string
  terminalHandle?: string
  explicitTerm?: string
  envToDelete?: string[]
  gitCredentialPromptGuarded?: boolean
  replayTail?: RelayPtyReplayTail
  durableLaunch?: RelayPtyDurableLaunch
  agentOwners?: AgentSessionOwnerBinding[]
  providerSession?: AgentProviderSessionMetadata
  orchestrationTaskId?: string
}

export type RelayPtyRetainedFields = Pick<
  RelayPtyPersistenceEntry,
  | 'id'
  | 'cwd'
  | 'paneKey'
  | 'tabId'
  | 'attachIdentity'
  | 'worktreeId'
  | 'terminalHandle'
  | 'explicitTerm'
  | 'envToDelete'
>

export type RelayPtyParsedPersistenceState =
  | { formatVersion: 'legacy'; entries: RelayPtyPersistenceEntry[] }
  | { formatVersion: 2; entries: RelayPtyPersistenceEntry[] }

export function sanitizeRelayPtyEnvToDelete(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((key): key is string => typeof key === 'string' && key.length > 0)
        .slice(0, MAX_RELAY_PTY_ENV_DELETE_KEYS)
    : []
}

export function assertRelayPtyRetainedFieldsWithinLimits(fields: RelayPtyRetainedFields): number {
  let retainedBytes = 0
  const add = (field: string, value: string | undefined): void => {
    if (value === undefined) {
      return
    }
    assertRelayPtyPersistenceFieldWithinLimit(field, value)
    const bytes = Buffer.byteLength(value, 'utf8')
    retainedBytes += bytes
  }

  add('id', fields.id)
  add('cwd', fields.cwd)
  add('paneKey', fields.paneKey)
  add('tabId', fields.tabId)
  add('attachIdentity.paneKey', fields.attachIdentity?.paneKey)
  add('attachIdentity.tabId', fields.attachIdentity?.tabId)
  add('worktreeId', fields.worktreeId)
  add('terminalHandle', fields.terminalHandle)
  add('explicitTerm', fields.explicitTerm)
  for (const key of fields.envToDelete ?? []) {
    add('envToDelete', key)
  }
  if (retainedBytes > MAX_RELAY_PTY_PERSISTENCE_ENTRY_BYTES) {
    throw new Error(
      `PTY persistence entry exceeds ${MAX_RELAY_PTY_PERSISTENCE_ENTRY_BYTES} retained bytes`
    )
  }
  return retainedBytes
}

export function serializeRelayPtyPersistenceEnvelope(
  entries: readonly RelayPtyPersistenceEntry[],
  maxEntries: number,
  formatVersion?: 2
): string {
  assertEnvelopeEntryCount(entries, maxEntries)
  if (formatVersion !== 2) {
    assertLegacyEnvelopeRetainedBytes(entries)
    return stringifyJsonWithinByteLimit(entries, MAX_RELAY_PTY_PERSISTENCE_STATE_BYTES).serialized
  }
  const boundedEntries = boundV2Entries(entries, maxEntries)
  return stringifyJsonWithinByteLimit(
    { schemaVersion: 2, entries: boundedEntries },
    MAX_RELAY_PTY_PERSISTENCE_STATE_BYTES
  ).serialized
}

export function parseRelayPtyPersistenceEnvelope(
  state: unknown,
  maxEntries: number
): RelayPtyPersistenceEntry[] {
  return parseRelayPtyPersistenceState(state, maxEntries).entries
}

export function parseRelayPtyPersistenceState(
  state: unknown,
  maxEntries: number
): RelayPtyParsedPersistenceState {
  if (typeof state !== 'string') {
    throw new Error('PTY persistence state must be JSON text')
  }
  if (Buffer.byteLength(state, 'utf8') > MAX_RELAY_PTY_PERSISTENCE_STATE_BYTES) {
    throw new Error(`PTY persistence state exceeds ${MAX_RELAY_PTY_PERSISTENCE_STATE_BYTES} bytes`)
  }
  assertJsonTextStructureWithinLimits(state, PTY_PERSISTENCE_JSON_STRUCTURE_LIMITS)
  const parsed = JSON.parse(state) as unknown
  if (Array.isArray(parsed)) {
    return { formatVersion: 'legacy', entries: normalizeLegacyEnvelope(parsed, maxEntries) }
  }
  return normalizeV2Envelope(parsed, maxEntries)
}

export function parseRelayPtyPersistenceIds(value: unknown, maxEntries: number): string[] {
  if (!Array.isArray(value) || value.length > maxEntries) {
    throw new Error(`PTY persistence request exceeds ${maxEntries} entries`)
  }
  const ids = value.map((id) => requiredString(id, 'id'))
  assertUniquePtyIds(ids, 'PTY persistence request')
  return ids
}

function normalizeLegacyEnvelope(value: unknown[], maxEntries: number): RelayPtyPersistenceEntry[] {
  assertEnvelopeEntryCount(value, maxEntries)
  const entries = value.map((entry, index) =>
    normalizeRelayPtyPersistenceEntry(entry, index, false)
  )
  assertLegacyEnvelopeRetainedBytes(entries)
  return entries
}

function normalizeV2Envelope(value: unknown, maxEntries: number): RelayPtyParsedPersistenceState {
  const envelope = requiredRecord(value, 'PTY persistence v2 envelope')
  assertExactKeys(envelope, ['schemaVersion', 'entries'], 'PTY persistence v2 envelope')
  if (envelope.schemaVersion !== 2 || !Array.isArray(envelope.entries)) {
    throw new Error('PTY persistence envelope version is unsupported')
  }
  assertEnvelopeEntryCount(envelope.entries, maxEntries)
  const entries = envelope.entries.map((entry, index) =>
    normalizeRelayPtyPersistenceEntry(entry, index, true)
  )
  assertUniquePtyIds(
    entries.map((entry) => entry.id),
    'PTY persistence v2 envelope'
  )
  assertV2EnvelopeRetainedBytes(entries)
  return { formatVersion: 2, entries }
}

function boundV2Entries(
  entries: readonly RelayPtyPersistenceEntry[],
  maxEntries: number
): RelayPtyPersistenceEntry[] {
  const normalized = entries.map((entry, index) =>
    normalizeRelayPtyPersistenceEntry(entry, index, true)
  )
  assertEnvelopeEntryCount(normalized, maxEntries)
  assertUniquePtyIds(
    normalized.map((entry) => entry.id),
    'PTY persistence v2 envelope'
  )
  let retainedBytes = 0
  return normalized.map((entry) => {
    const withoutTail = { ...entry }
    delete withoutTail.replayTail
    const metadataBytes = serializedRelayPtyPersistenceEntry(withoutTail)
    if (metadataBytes > MAX_RELAY_PTY_PERSISTENCE_ENTRY_BYTES) {
      throw new Error(
        `PTY persistence entry exceeds ${MAX_RELAY_PTY_PERSISTENCE_ENTRY_BYTES} retained bytes`
      )
    }
    if (retainedBytes + metadataBytes > MAX_RELAY_PTY_PERSISTENCE_RETAINED_BYTES) {
      throw new Error(
        `PTY persistence state exceeds ${MAX_RELAY_PTY_PERSISTENCE_RETAINED_BYTES} retained bytes`
      )
    }
    const sourceReplayTail = entry.replayTail
    if (!sourceReplayTail) {
      retainedBytes += metadataBytes
      return withoutTail
    }
    const minimumTail: RelayPtyReplayTail = {
      data: '',
      encoding: 'utf8',
      byteLength: 0,
      truncated: true
    }
    const minimumCandidate = { ...entry, replayTail: minimumTail }
    const minimumCandidateBytes = serializedRelayPtyPersistenceEntry(minimumCandidate)
    if (
      minimumCandidateBytes > MAX_RELAY_PTY_PERSISTENCE_ENTRY_BYTES ||
      retainedBytes + minimumCandidateBytes > MAX_RELAY_PTY_PERSISTENCE_RETAINED_BYTES
    ) {
      throw new Error('PTY persistence state cannot retain a truncated replay tail')
    }
    let tailBudget = Math.max(
      0,
      Math.min(
        MAX_RELAY_PTY_LOST_TAIL_BYTES,
        MAX_RELAY_PTY_PERSISTENCE_ENTRY_BYTES - metadataBytes,
        MAX_RELAY_PTY_PERSISTENCE_RETAINED_BYTES - retainedBytes - metadataBytes
      )
    )
    let replayTail = boundReplayTail(sourceReplayTail, tailBudget)
    while (true) {
      const candidate = { ...entry, replayTail }
      const candidateBytes = serializedRelayPtyPersistenceEntry(candidate)
      const excess = Math.max(
        candidateBytes - MAX_RELAY_PTY_PERSISTENCE_ENTRY_BYTES,
        retainedBytes + candidateBytes - MAX_RELAY_PTY_PERSISTENCE_RETAINED_BYTES
      )
      if (excess <= 0) {
        retainedBytes += candidateBytes
        return candidate
      }
      if (replayTail.byteLength === 0) {
        throw new Error('PTY persistence state cannot retain a truncated replay tail')
      }
      tailBudget = Math.max(0, replayTail.byteLength - excess - 4)
      replayTail = boundReplayTail(sourceReplayTail, tailBudget)
    }
  })
}

function boundReplayTail(tail: RelayPtyReplayTail, maxBytes: number): RelayPtyReplayTail {
  const clamped = clampUtf8TextTail(tail.data, maxBytes)
  return {
    data: clamped.text,
    encoding: 'utf8',
    byteLength: clamped.bytes,
    truncated: tail.truncated || clamped.bytes !== tail.byteLength
  }
}

function assertEnvelopeEntryCount(value: readonly unknown[], maxEntries: number): void {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
    throw new RangeError('PTY persistence entry limit must be a non-negative safe integer')
  }
  if (value.length > maxEntries) {
    throw new Error(`PTY persistence state exceeds ${maxEntries} entries`)
  }
}

function assertUniquePtyIds(ids: readonly string[], scope: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${scope} contains duplicate PTY ids`)
  }
}

function assertLegacyEnvelopeRetainedBytes(entries: readonly RelayPtyRetainedFields[]): void {
  let retainedBytes = 0
  for (const entry of entries) {
    assertRelayPtyPersistenceEntrySize(entry)
    retainedBytes += assertRelayPtyRetainedFieldsWithinLimits(entry)
    if (retainedBytes > MAX_RELAY_PTY_PERSISTENCE_RETAINED_BYTES) {
      throw new Error(
        `PTY persistence state exceeds ${MAX_RELAY_PTY_PERSISTENCE_RETAINED_BYTES} retained bytes`
      )
    }
  }
}

export {
  assertRelayPtyPersistenceFieldWithinLimit,
  MAX_RELAY_PTY_PERSISTENCE_FIELD_BYTES
} from '../shared/pty-persistence-wire-limits'
