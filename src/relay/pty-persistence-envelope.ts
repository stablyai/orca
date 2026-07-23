import { assertJsonTextStructureWithinLimits } from '../shared/json-text-structure-limit'
import { stringifyJsonWithinByteLimit } from '../shared/node-bounded-json-stringify'
import { terminalSizeAdmissionError } from '../shared/terminal-size-limits'

export const MAX_RELAY_PTY_PERSISTENCE_STATE_BYTES = 8 * 1024 * 1024
export const MAX_RELAY_PTY_PERSISTENCE_FIELD_BYTES = 64 * 1024
export const MAX_RELAY_PTY_PERSISTENCE_ENTRY_BYTES = 128 * 1024
export const MAX_RELAY_PTY_PERSISTENCE_RETAINED_BYTES = 6 * 1024 * 1024
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
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes > MAX_RELAY_PTY_PERSISTENCE_FIELD_BYTES) {
      throw new Error(
        `PTY persistence field "${field}" exceeds ${MAX_RELAY_PTY_PERSISTENCE_FIELD_BYTES} bytes`
      )
    }
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
  maxEntries: number
): string {
  assertEnvelopeEntryCount(entries, maxEntries)
  assertEnvelopeRetainedBytes(entries)
  return stringifyJsonWithinByteLimit(entries, MAX_RELAY_PTY_PERSISTENCE_STATE_BYTES).serialized
}

export function parseRelayPtyPersistenceEnvelope(
  state: unknown,
  maxEntries: number
): RelayPtyPersistenceEntry[] {
  if (typeof state !== 'string') {
    throw new Error('PTY persistence state must be JSON text')
  }
  if (Buffer.byteLength(state, 'utf8') > MAX_RELAY_PTY_PERSISTENCE_STATE_BYTES) {
    throw new Error(`PTY persistence state exceeds ${MAX_RELAY_PTY_PERSISTENCE_STATE_BYTES} bytes`)
  }
  assertJsonTextStructureWithinLimits(state, PTY_PERSISTENCE_JSON_STRUCTURE_LIMITS)
  return normalizeEnvelope(JSON.parse(state) as unknown, maxEntries)
}

export function parseRelayPtyPersistenceIds(value: unknown, maxEntries: number): string[] {
  if (!Array.isArray(value) || value.length > maxEntries) {
    throw new Error(`PTY persistence request exceeds ${maxEntries} entries`)
  }
  return value.map((id) => requiredString(id, 'id'))
}

function normalizeEnvelope(value: unknown, maxEntries: number): RelayPtyPersistenceEntry[] {
  if (!Array.isArray(value)) {
    throw new Error(`PTY persistence state exceeds ${maxEntries} entries`)
  }
  assertEnvelopeEntryCount(value, maxEntries)

  const entries = value.map((entry, index) => normalizeEntry(entry, index))
  assertEnvelopeRetainedBytes(entries)
  return entries
}

function assertEnvelopeEntryCount(value: readonly unknown[], maxEntries: number): void {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
    throw new RangeError('PTY persistence entry limit must be a non-negative safe integer')
  }
  if (value.length > maxEntries) {
    throw new Error(`PTY persistence state exceeds ${maxEntries} entries`)
  }
}

function assertEnvelopeRetainedBytes(entries: readonly RelayPtyRetainedFields[]): void {
  let retainedBytes = 0
  for (const entry of entries) {
    const dimensions = entry as Partial<RelayPtyPersistenceEntry>
    const sizeError = terminalSizeAdmissionError(
      dimensions.cols,
      dimensions.rows,
      'PTY persistence entry',
      { allowMissing: true }
    )
    if (sizeError) {
      throw new Error(sizeError)
    }
    retainedBytes += assertRelayPtyRetainedFieldsWithinLimits(entry)
    if (retainedBytes > MAX_RELAY_PTY_PERSISTENCE_RETAINED_BYTES) {
      throw new Error(
        `PTY persistence state exceeds ${MAX_RELAY_PTY_PERSISTENCE_RETAINED_BYTES} retained bytes`
      )
    }
  }
}

function normalizeEntry(value: unknown, index: number): RelayPtyPersistenceEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`PTY persistence entry ${index} must be an object`)
  }
  const entry = value as Record<string, unknown>
  const attachIdentity = normalizeIdentity(entry.attachIdentity)
  const paneKey = optionalString(entry.paneKey, 'paneKey')
  const tabId = optionalString(entry.tabId, 'tabId')
  const worktreeId = optionalString(entry.worktreeId, 'worktreeId')
  const terminalHandle = optionalString(entry.terminalHandle, 'terminalHandle')
  const explicitTerm = optionalString(entry.explicitTerm, 'explicitTerm')
  const envToDelete = sanitizeRelayPtyEnvToDelete(entry.envToDelete)
  const cols = positiveSafeIntegerOrDefault(entry.cols, 'cols', 80)
  const rows = positiveSafeIntegerOrDefault(entry.rows, 'rows', 24)
  const sizeError = terminalSizeAdmissionError(cols, rows, 'PTY persistence entry')
  if (sizeError) {
    throw new Error(sizeError)
  }

  return {
    id: requiredString(entry.id, 'id'),
    pid: positiveSafeInteger(entry.pid, 'pid'),
    cols,
    rows,
    cwd: requiredString(entry.cwd, 'cwd'),
    ...(paneKey === undefined ? {} : { paneKey }),
    ...(tabId === undefined ? {} : { tabId }),
    ...(attachIdentity === undefined ? {} : { attachIdentity }),
    ...(worktreeId === undefined ? {} : { worktreeId }),
    ...(terminalHandle === undefined ? {} : { terminalHandle }),
    ...(explicitTerm === undefined ? {} : { explicitTerm }),
    ...(Array.isArray(entry.envToDelete) ? { envToDelete } : {}),
    gitCredentialPromptGuarded: entry.gitCredentialPromptGuarded === true
  }
}

function normalizeIdentity(value: unknown): RelayPtyIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const identity = value as Record<string, unknown>
  const paneKey = optionalString(identity.paneKey, 'attachIdentity.paneKey')
  const tabId = optionalString(identity.tabId, 'attachIdentity.tabId')
  return paneKey === undefined && tabId === undefined ? undefined : { paneKey, tabId }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`PTY persistence field "${field}" must be a string`)
  }
  assertRelayPtyPersistenceFieldWithinLimit(field, value)
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined
  }
  return requiredString(value, field)
}

export function assertRelayPtyPersistenceFieldWithinLimit(field: string, value: string): void {
  if (Buffer.byteLength(value, 'utf8') > MAX_RELAY_PTY_PERSISTENCE_FIELD_BYTES) {
    throw new Error(
      `PTY persistence field "${field}" exceeds ${MAX_RELAY_PTY_PERSISTENCE_FIELD_BYTES} bytes`
    )
  }
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`PTY persistence field "${field}" must be a positive safe integer`)
  }
  return value as number
}

function positiveSafeIntegerOrDefault(value: unknown, field: string, fallback: number): number {
  return value === undefined ? fallback : positiveSafeInteger(value, field)
}
