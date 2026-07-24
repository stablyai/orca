import {
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from '../shared/agent-session-resume'
import { normalizeAgentSessionOwnerBindings } from '../shared/agent-session-owner-wire-normalization'
import type { AgentSessionOwnerBinding } from '../shared/agent-session-host-authority'
import { assertRelayPtyPersistenceFieldWithinLimit } from '../shared/pty-persistence-wire-limits'
import type { RelayPtyDurableLaunch, RelayPtyReplayTail } from '../shared/pty-revive-protocol'
import { isTuiAgent } from '../shared/tui-agent-config'
import { measureUtf8ByteLength } from '../shared/utf8-byte-limits'
import { terminalSizeAdmissionError } from '../shared/terminal-size-limits'
import { normalizeRelayPtyV2EntryBasics } from './pty-persistence-v2-entry-basics'
import {
  MAX_RELAY_PTY_LOST_TAIL_BYTES,
  MAX_RELAY_PTY_PERSISTENCE_ENTRY_BYTES,
  MAX_RELAY_PTY_PERSISTENCE_RETAINED_BYTES,
  sanitizeRelayPtyEnvToDelete,
  type RelayPtyIdentity,
  type RelayPtyPersistenceEntry
} from './pty-persistence-envelope'

export function assertV2EnvelopeRetainedBytes(entries: readonly RelayPtyPersistenceEntry[]): void {
  let retainedBytes = 0
  for (const entry of entries) {
    assertRelayPtyPersistenceEntrySize(entry)
    const entryBytes = serializedRelayPtyPersistenceEntry(entry)
    if (entryBytes > MAX_RELAY_PTY_PERSISTENCE_ENTRY_BYTES) {
      throw new Error(
        `PTY persistence entry exceeds ${MAX_RELAY_PTY_PERSISTENCE_ENTRY_BYTES} retained bytes`
      )
    }
    retainedBytes += entryBytes
    if (retainedBytes > MAX_RELAY_PTY_PERSISTENCE_RETAINED_BYTES) {
      throw new Error(
        `PTY persistence state exceeds ${MAX_RELAY_PTY_PERSISTENCE_RETAINED_BYTES} retained bytes`
      )
    }
  }
}

export function assertRelayPtyPersistenceEntrySize(entry: Partial<RelayPtyPersistenceEntry>): void {
  const sizeError = terminalSizeAdmissionError(entry.cols, entry.rows, 'PTY persistence entry', {
    allowMissing: true
  })
  if (sizeError) {
    throw new Error(sizeError)
  }
}

export function normalizeRelayPtyPersistenceEntry(
  value: unknown,
  index: number,
  v2: boolean
): RelayPtyPersistenceEntry {
  const entry = requiredRecord(value, `PTY persistence entry ${index}`)
  if (v2) {
    assertExactKeys(
      entry,
      [
        'id',
        'pid',
        'sourceIncarnationId',
        'cols',
        'rows',
        'cwd',
        'paneKey',
        'tabId',
        'attachIdentity',
        'worktreeId',
        'terminalHandle',
        'explicitTerm',
        'envToDelete',
        'gitCredentialPromptGuarded',
        'replayTail',
        'durableLaunch',
        'agentOwners',
        'providerSession',
        'orchestrationTaskId'
      ],
      `PTY persistence entry ${index}`
    )
  }
  const v2Basics = v2 ? normalizeRelayPtyV2EntryBasics(entry) : undefined
  const id = requiredString(entry.id, 'id', !v2)
  const attachIdentity = v2Basics?.attachIdentity ?? normalizeLegacyIdentity(entry.attachIdentity)
  const paneKey = optionalString(entry.paneKey, 'paneKey')
  const tabId = optionalString(entry.tabId, 'tabId')
  const worktreeId = optionalString(entry.worktreeId, 'worktreeId')
  const terminalHandle = optionalString(entry.terminalHandle, 'terminalHandle')
  const explicitTerm = optionalString(entry.explicitTerm, 'explicitTerm')
  const envToDelete = v2 ? v2Basics?.envToDelete : sanitizeRelayPtyEnvToDelete(entry.envToDelete)
  const cols = positiveSafeIntegerOrDefault(entry.cols, 'cols', 80)
  const rows = positiveSafeIntegerOrDefault(entry.rows, 'rows', 24)
  assertRelayPtyPersistenceEntrySize({ cols, rows })
  const sourceIncarnationId = v2
    ? requiredString(entry.sourceIncarnationId, 'sourceIncarnationId', false)
    : undefined
  const replayTail = v2 ? normalizeReplayTail(entry.replayTail) : undefined
  const durableLaunch = v2 ? normalizeDurableLaunch(entry.durableLaunch) : undefined
  const agentOwners = v2 ? normalizeAgentOwners(entry.agentOwners, id) : undefined
  const providerSession = v2 ? normalizeProviderSession(entry.providerSession) : undefined
  const orchestrationTaskId = v2
    ? optionalString(entry.orchestrationTaskId, 'orchestrationTaskId')
    : undefined
  return {
    id,
    pid: positiveSafeInteger(entry.pid, 'pid'),
    cols,
    rows,
    cwd: requiredString(entry.cwd, 'cwd', !v2),
    ...(sourceIncarnationId === undefined ? {} : { sourceIncarnationId }),
    ...(paneKey === undefined ? {} : { paneKey }),
    ...(tabId === undefined ? {} : { tabId }),
    ...(attachIdentity === undefined ? {} : { attachIdentity }),
    ...(worktreeId === undefined ? {} : { worktreeId }),
    ...(terminalHandle === undefined ? {} : { terminalHandle }),
    ...(explicitTerm === undefined ? {} : { explicitTerm }),
    ...(envToDelete === undefined ? {} : { envToDelete }),
    gitCredentialPromptGuarded: v2
      ? v2Basics!.gitCredentialPromptGuarded
      : entry.gitCredentialPromptGuarded === true,
    ...(replayTail === undefined ? {} : { replayTail }),
    ...(durableLaunch === undefined ? {} : { durableLaunch }),
    ...(agentOwners === undefined ? {} : { agentOwners }),
    ...(providerSession === undefined ? {} : { providerSession }),
    ...(orchestrationTaskId === undefined ? {} : { orchestrationTaskId })
  }
}

export function serializedRelayPtyPersistenceEntry(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function normalizeLegacyIdentity(value: unknown): RelayPtyIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const identity = value as Record<string, unknown>
  const paneKey = optionalString(identity.paneKey, 'attachIdentity.paneKey')
  const tabId = optionalString(identity.tabId, 'attachIdentity.tabId')
  return paneKey === undefined && tabId === undefined ? undefined : { paneKey, tabId }
}

function normalizeReplayTail(value: unknown): RelayPtyReplayTail | undefined {
  if (value === undefined) {
    return undefined
  }
  const tail = requiredRecord(value, 'replayTail')
  assertExactKeys(tail, ['data', 'encoding', 'byteLength', 'truncated'], 'replayTail')
  if (
    tail.encoding !== 'utf8' ||
    typeof tail.truncated !== 'boolean' ||
    typeof tail.data !== 'string'
  ) {
    throw new Error('PTY persistence replay tail is invalid')
  }
  const byteLength = nonNegativeSafeInteger(tail.byteLength, 'replayTail.byteLength')
  if (
    measureUtf8ByteLength(tail.data).byteLength !== byteLength ||
    byteLength > MAX_RELAY_PTY_LOST_TAIL_BYTES
  ) {
    throw new Error('PTY persistence replay tail is invalid')
  }
  return { data: tail.data, encoding: 'utf8', byteLength, truncated: tail.truncated }
}

function normalizeDurableLaunch(value: unknown): RelayPtyDurableLaunch | undefined {
  if (value === undefined) {
    return undefined
  }
  const launch = requiredRecord(value, 'durableLaunch')
  assertExactKeys(
    launch,
    ['startupCommand', 'shellOverride', 'launchAgent', 'startedAt'],
    'durableLaunch'
  )
  const startupCommand = optionalString(launch.startupCommand, 'durableLaunch.startupCommand')
  const shellOverride = optionalString(launch.shellOverride, 'durableLaunch.shellOverride')
  if (launch.launchAgent !== undefined && !isTuiAgent(launch.launchAgent)) {
    throw new Error('PTY persistence durable launch agent is invalid')
  }
  if (
    launch.startedAt !== undefined &&
    (typeof launch.startedAt !== 'number' ||
      !Number.isFinite(launch.startedAt) ||
      launch.startedAt < 0)
  ) {
    throw new Error('PTY persistence durable launch startedAt is invalid')
  }
  return {
    ...(startupCommand === undefined ? {} : { startupCommand }),
    ...(shellOverride === undefined ? {} : { shellOverride }),
    ...(launch.launchAgent === undefined ? {} : { launchAgent: launch.launchAgent }),
    ...(launch.startedAt === undefined ? {} : { startedAt: launch.startedAt as number })
  }
}

function normalizeAgentOwners(
  value: unknown,
  entryId: string
): AgentSessionOwnerBinding[] | undefined {
  if (value === undefined) {
    return undefined
  }
  return normalizeAgentSessionOwnerBindings(value, entryId, 'PTY persistence')
}

function normalizeProviderSession(value: unknown): AgentProviderSessionMetadata | undefined {
  if (value === undefined) {
    return undefined
  }
  const record = requiredRecord(value, 'providerSession')
  assertExactKeys(record, ['key', 'id', 'transcriptPath'], 'providerSession')
  const providerSession = normalizeAgentProviderSession(record)
  if (!providerSession) {
    throw new Error('PTY persistence provider session is invalid')
  }
  assertRelayPtyPersistenceFieldWithinLimit('providerSession.id', providerSession.id)
  if (providerSession.transcriptPath) {
    assertRelayPtyPersistenceFieldWithinLimit(
      'providerSession.transcriptPath',
      providerSession.transcriptPath
    )
  }
  return providerSession
}

export function requiredString(value: unknown, field: string, allowEmpty = true): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`PTY persistence field "${field}" must be a string`)
  }
  assertRelayPtyPersistenceFieldWithinLimit(field, value)
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field)
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`PTY persistence field "${field}" must be a positive safe integer`)
  }
  return value
}

function positiveSafeIntegerOrDefault(value: unknown, field: string, fallback: number): number {
  return value === undefined ? fallback : positiveSafeInteger(value, field)
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`PTY persistence field "${field}" must be a non-negative safe integer`)
  }
  return value
}

export function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

export function assertExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  name: string
): void {
  if (Object.keys(record).some((key) => !keys.includes(key))) {
    throw new Error(`${name} contains an unknown field`)
  }
}
