import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import { usableJournalHistoryOrigin } from './context-epochs/journal-history-origin'
import {
  CLAUDE_IMPORT_ENTRIES_BYTES,
  claudeImportEntryBytes,
  wideField
} from './history-import/journal-claude-import-pages'
import { ClaudeImportResourceError } from './history-import/journal-claude-import-resource-error'
import type { ClaudeImportFieldFragment } from './history-import/journal-claude-import-worker-protocol'
import { digestPayload } from './item-lifecycle/journal-payload-bounds'
import type { JournalHistoryItemSource } from './journal-history-items'
import { JournalStoredJsonSizeError } from './journal-stored-json-bounds'

type Field = {
  kind: 'text' | 'tool-result' | 'tool-input' | 'tool-output'
  blockIndex: number | null
}
type Position = { ordinal: number; offset: number }
type SavedRevision = { canonicalItemId: string; revision: number }
type Fingerprint = SavedRevision & {
  keyIndex: number
  field: Field
  callId?: string
  byteLength: number
  digest: string
  jsonBytes: number
}

export type JournalClaudeRecoveryRead =
  | {
      kind: 'claude-recovery-fingerprints'
      cursor: AgentJournalCursor
      keys: readonly string[]
      after: Position
    }
  | ({
      kind: 'claude-recovery-slices'
      epoch: string
      key: string
      fields: readonly Field[]
      after: Position
    } & SavedRevision)
  | {
      kind: 'claude-recovery-origin'
      cursor: AgentJournalCursor
      providerSessionId: string
      after: Position
    }

export type JournalClaudeRecoveryReadResult =
  | { kind: 'claude-recovery-fingerprints'; fingerprints: Fingerprint[]; next: Position | null }
  | {
      kind: 'claude-recovery-slices'
      fragments: ClaudeImportFieldFragment[]
      next: Position | null
    }
  | {
      kind: 'claude-recovery-origin'
      fragments: ClaudeImportFieldFragment[]
      next: Position | null
    }

type SavedField = { field: Field; value: unknown; callId?: string }
type Prefix = readonly [string, string]
const DIGEST_PLACEHOLDER = '0'.repeat(64)

function toolInput(
  blockIndex: number | null,
  call: { callId?: string; input: unknown }
): SavedField | undefined {
  return call.callId
    ? { field: { kind: 'tool-input', blockIndex }, value: call.input ?? null, callId: call.callId }
    : undefined
}

// One slot per message block, or input plus output for a standalone call.
function savedField(body: AgentJournalItemBody, index: number): SavedField | undefined {
  if (body.kind === 'tool-call') {
    if (index === 0) {
      return toolInput(null, body)
    }
    if (index === 1 && body.output && !body.output.truncated) {
      return { field: { kind: 'tool-output', blockIndex: null }, value: body.output.head }
    }
  }
  if (body.kind === 'message') {
    const block = body.blocks[index]
    if (block?.type === 'text') {
      return { field: { kind: 'text', blockIndex: index }, value: block.text }
    }
    if (block?.type === 'tool-result') {
      return { field: { kind: 'tool-result', blockIndex: index }, value: block.output }
    }
    if (block?.type === 'tool-call') {
      return toolInput(index, block)
    }
  }
  return undefined
}

function requireCursor(db: Database.Database, prefix: Prefix, cursor: AgentJournalCursor): void {
  if (
    prefix[1] !== cursor.epoch ||
    db
      .prepare('SELECT last_sequence FROM journal_chat_state WHERE session_id=? AND epoch=?')
      .get(...prefix)?.last_sequence !== cursor.sequence
  ) {
    throw new Error('Saved Claude history changed during recovery.')
  }
}

function readFingerprints(
  source: JournalHistoryItemSource,
  operation: Extract<JournalClaudeRecoveryRead, { kind: 'claude-recovery-fingerprints' }>
): Omit<
  Extract<JournalClaudeRecoveryReadResult, { kind: 'claude-recovery-fingerprints' }>,
  'kind'
> {
  const fingerprints: Fingerprint[] = []
  let bytes = 0
  for (let keyIndex = operation.after.ordinal; keyIndex < operation.keys.length; keyIndex++) {
    const key = operation.keys[keyIndex]!
    if (source.presentationRemoved(key)) {
      continue
    }
    const canonicalItemId = source.canonicalItemId(key)
    let item
    try {
      item = source.item(canonicalItemId)
    } catch (error) {
      if (error instanceof JournalStoredJsonSizeError) {
        if (fingerprints.length) {
          return { fingerprints, next: { ordinal: keyIndex, offset: 0 } }
        }
        throw new ClaudeImportResourceError('A saved Claude row exceeds the reader capacity.', {
          cause: error
        })
      }
      throw error
    }
    if (!item) {
      continue
    }
    const { body } = item
    const slots = body.kind === 'message' ? body.blocks.length : 2
    for (
      let index = keyIndex === operation.after.ordinal ? operation.after.offset : 0;
      index < slots;
      index++
    ) {
      const saved = savedField(body, index)
      if (!saved) {
        continue
      }
      const json = JSON.stringify(saved.value)
      const encoded = typeof saved.value === 'string' && !saved.callId ? saved.value : json
      const field = {
        keyIndex,
        canonicalItemId,
        revision: item.revision,
        field: saved.field,
        ...(saved.callId ? { callId: saved.callId } : {}),
        byteLength: Buffer.byteLength(encoded),
        digest: DIGEST_PLACEHOLDER,
        jsonBytes: Buffer.byteLength(json)
      }
      const size = claudeImportEntryBytes(field)
      if (bytes + size > CLAUDE_IMPORT_ENTRIES_BYTES) {
        if (!fingerprints.length) {
          throw new ClaudeImportResourceError('A saved Claude fingerprint exceeds the page limit.')
        }
        return { fingerprints, next: { ordinal: keyIndex, offset: index } }
      }
      field.digest = digestPayload(encoded)
      fingerprints.push(field)
      bytes += size
    }
  }
  return { fingerprints, next: null }
}

function readFragments(
  count: number,
  after: Position,
  field: (ordinal: number) => { path: string[]; value: unknown }
) {
  if (
    !Number.isSafeInteger(after.ordinal) ||
    after.ordinal < 0 ||
    after.ordinal >= count ||
    !Number.isSafeInteger(after.offset) ||
    after.offset < 0
  ) {
    throw new Error('Invalid saved Claude history slice position.')
  }
  const fragments: ClaudeImportFieldFragment[] = []
  let bytes = 0
  for (let ordinal = after.ordinal; ordinal < count; ordinal++) {
    const { path, value } = field(ordinal)
    const start = ordinal === after.ordinal ? after.offset : 0
    let offset = start
    for (const { entry, size } of wideField(path, value, offset)) {
      if (bytes + size > CLAUDE_IMPORT_ENTRIES_BYTES) {
        return { fragments, next: { ordinal, offset } }
      }
      fragments.push(entry)
      bytes += size
      offset++
    }
    if (offset === start) {
      throw new Error('Invalid saved Claude history slice offset.')
    }
  }
  return { fragments, next: null }
}

export function readJournalClaudeRecovery(
  db: Database.Database,
  prefix: Prefix,
  history: () => JournalHistoryItemSource,
  operation: JournalClaudeRecoveryRead
): JournalClaudeRecoveryReadResult {
  switch (operation.kind) {
    case 'claude-recovery-fingerprints':
      requireCursor(db, prefix, operation.cursor)
      return { kind: operation.kind, ...readFingerprints(history(), operation) }
    case 'claude-recovery-slices': {
      const source = history()
      const { key, canonicalItemId, revision, fields, after } = operation
      const item =
        prefix[1] === operation.epoch &&
        source.canonicalItemId(key) === canonicalItemId &&
        !source.presentationRemoved(key)
          ? source.item(canonicalItemId)
          : null
      if (!item || item.revision !== revision) {
        throw new Error('Saved Claude history changed during recovery.')
      }
      return {
        kind: operation.kind,
        ...readFragments(fields.length, after, (ordinal) => {
          const address = fields[ordinal]!
          const index = address.blockIndex ?? (address.kind === 'tool-output' ? 1 : 0)
          const saved = savedField(item.body, index)
          if (
            !saved ||
            saved.field.kind !== address.kind ||
            saved.field.blockIndex !== address.blockIndex
          ) {
            throw new Error('Saved Claude history field changed during recovery.')
          }
          return { path: [String(ordinal)], value: saved.value }
        })
      }
    }
    case 'claude-recovery-origin': {
      requireCursor(db, prefix, operation.cursor)
      const row = db
        .prepare(
          'SELECT history_origin_json FROM journal_chat_state WHERE session_id=? AND epoch=?'
        )
        .get(...prefix)
      const origin =
        row?.history_origin_json == null
          ? null
          : usableJournalHistoryOrigin(JSON.parse(String(row.history_origin_json)))
      if (
        origin?.kind !== 'native_copy' ||
        origin.agent !== 'claude' ||
        origin.unit !== 'claude-entry' ||
        origin.providerHandle.kind !== 'claude' ||
        origin.providerHandle.sessionId !== operation.providerSessionId
      ) {
        return { kind: operation.kind, fragments: [], next: null }
      }
      const { ids, ...header } = origin
      if (operation.after.ordinal === 0 && operation.after.offset === 0) {
        const fragments: ClaudeImportFieldFragment[] = [
          { kind: 'wide-field', path: ['header'], value: header },
          { kind: 'wide-field', path: ['ids'], value: ids }
        ]
        if (
          fragments.reduce((bytes, fragment) => bytes + claudeImportEntryBytes(fragment), 0) <=
          CLAUDE_IMPORT_ENTRIES_BYTES
        ) {
          return { kind: operation.kind, fragments, next: null }
        }
      }
      return {
        kind: operation.kind,
        ...readFragments(ids.length + 2, operation.after, (ordinal) =>
          ordinal === 0
            ? { path: ['header'], value: header }
            : ordinal === 1
              ? { path: ['ids'], value: [] }
              : { path: ['ids', String(ordinal - 2)], value: ids[ordinal - 2]! }
        )
      }
    }
  }
}
