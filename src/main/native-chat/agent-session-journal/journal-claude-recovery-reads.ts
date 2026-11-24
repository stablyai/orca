import {
  claudeRecoveryFragmentBytes,
  readClaudeRecoveryFragmentPage,
  type ClaudeRecoveryFragment,
  type ClaudeRecoveryPosition
} from './journal-claude-recovery-fragments'
import { journalRecoveryPageEntriesBytes } from './journal-sql-reader-reply-limit'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { savedField, type Field } from './journal-claude-recovery-fields'
import type Database from '../../sqlite/sync-database'
import {
  readClaudeRecoveryOriginHeader,
  readClaudeRecoveryOriginIds,
  requireClaudeRecoveryCursor
} from './journal-claude-recovery-origin'
import type { NativeCopyOriginHeader } from './context-epochs/journal-history-origin'
import { claudeImportEntryBytes, wideField } from './history-import/journal-claude-import-pages'
import { ClaudeImportResourceError } from './history-import/journal-claude-import-resource-error'
import {
  CLAUDE_RECOVERY_CONCURRENCY,
  type ClaudeImportFieldFragment
} from './history-import/journal-claude-import-worker-protocol'
import { digestPayload } from './item-lifecycle/journal-payload-bounds'
import type { JournalHistoryItemSource } from './journal-history-items'
import { JournalStoredJsonSizeError } from './journal-stored-json-bounds'

type Position = ClaudeRecoveryPosition
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
      outputLengths?: readonly (readonly number[])[]
      after: Position
    }
  | ({
      kind: 'claude-recovery-slices'
      epoch: string
      key: string
      transferId: string
      fields?: readonly Field[]
      after: Position
    } & SavedRevision)
  | { kind: 'claude-recovery-goal'; cursor: AgentJournalCursor }
  | { kind: 'claude-recovery-release'; transferId: string }
  | { kind: 'claude-recovery-header'; cursor?: AgentJournalCursor; providerSessionId?: string }
  | {
      kind: 'claude-recovery-origin'
      cursor: AgentJournalCursor
      after: Position
    }

export type JournalClaudeRecoveryReadResult =
  | { kind: 'claude-recovery-fingerprints'; fingerprints: Fingerprint[]; next: Position | null }
  | {
      kind: 'claude-recovery-slices'
      fragments: ClaudeImportFieldFragment[]
      next: Position | null
    }
  | { kind: 'claude-recovery-goal'; cost: { itemId: string; bytes: number } | null }
  | { kind: 'claude-recovery-release' }
  | { kind: 'claude-recovery-header'; header: NativeCopyOriginHeader | null }
  | {
      kind: 'claude-recovery-origin'
      fragments: ClaudeImportFieldFragment[]
      next: Position | null
    }

type Prefix = readonly [string, string]
const FINGERPRINT_BYTES = journalRecoveryPageEntriesBytes({
  kind: 'claude-recovery-fingerprints',
  fingerprints: [],
  next: { ordinal: Number.MAX_SAFE_INTEGER, offset: Number.MAX_SAFE_INTEGER }
})
const SLICE_BYTES = claudeRecoveryFragmentBytes('claude-recovery-slices')
const DIGEST_PLACEHOLDER = '0'.repeat(64)

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
    const outputLengths = operation.outputLengths?.[keyIndex]
    const slots = body.kind === 'message' ? body.blocks.length : outputLengths?.length ? 2 : 1
    for (
      let index = keyIndex === operation.after.ordinal ? operation.after.offset : 0;
      index < slots;
      index++
    ) {
      const saved = savedField(body, index)
      if (!saved) {
        continue
      }
      if (
        saved.field.kind === 'tool-output' &&
        typeof saved.value === 'string' &&
        !outputLengths?.includes(Buffer.byteLength(saved.value))
      ) {
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
      if (bytes + size > FINGERPRINT_BYTES) {
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

type Slice = Extract<JournalClaudeRecoveryRead, { kind: 'claude-recovery-slices' }>
type Transfer = {
  prefix: Prefix
  key: string
  canonicalItemId: string
  revision: number
  available: Generator<ClaudeRecoveryFragment>
  pending: IteratorResult<ClaudeRecoveryFragment>
}

// A transfer owns only the matched fields and a paused fragment iterator, never a WAL snapshot.
const transfersByReader = new WeakMap<Database.Database, Map<string, Transfer>>()

function* sliceFields(values: readonly unknown[]): Generator<ClaudeRecoveryFragment> {
  for (const [ordinal, value] of values.entries()) {
    let offset = 0
    for (const fragment of wideField([String(ordinal)], value, 0, SLICE_BYTES)) {
      yield { ...fragment, at: { ordinal, offset: offset++ } }
    }
  }
}

function readSlices(
  db: Database.Database,
  prefix: Prefix,
  source: JournalHistoryItemSource,
  request: Slice
) {
  const { transferId, after, key, canonicalItemId, revision, fields } = request
  let transfers = transfersByReader.get(db)
  if (!transfers) {
    transfers = new Map()
    transfersByReader.set(db, transfers)
  }
  const existing = transfers.get(transferId)
  transfers.delete(transferId)
  const visible = db
    .prepare(`SELECT revision FROM journal_items
    WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0`)
    .get(...prefix, canonicalItemId)
  if (
    prefix[1] !== request.epoch ||
    source.canonicalItemId(key) !== canonicalItemId ||
    source.presentationRemoved(key) ||
    visible?.revision !== revision
  ) {
    throw new Error('Saved Claude history changed during recovery.')
  }
  let available: Generator<ClaudeRecoveryFragment>
  let pending: IteratorResult<ClaudeRecoveryFragment> | undefined
  if (existing) {
    pending = existing.pending
    if (
      pending.done ||
      pending.value.at.ordinal !== after.ordinal ||
      pending.value.at.offset !== after.offset ||
      existing.prefix[0] !== prefix[0] ||
      existing.prefix[1] !== prefix[1] ||
      existing.key !== key ||
      existing.canonicalItemId !== canonicalItemId ||
      existing.revision !== revision
    ) {
      throw new Error('Invalid saved Claude history slice position.')
    }
    available = existing.available
  } else {
    if (!fields || after.ordinal !== 0 || after.offset !== 0) {
      throw new Error('Saved Claude history transfer is no longer available.')
    }
    const item = source.item(canonicalItemId)
    if (!item || item.revision !== revision) {
      throw new Error('Saved Claude history changed during recovery.')
    }
    available = sliceFields(
      fields.map((address) => {
        const saved = savedField(
          item.body,
          address.blockIndex ?? (address.kind === 'tool-output' ? 1 : 0)
        )
        if (
          !saved ||
          saved.field.kind !== address.kind ||
          saved.field.blockIndex !== address.blockIndex
        ) {
          throw new Error('Saved Claude history field changed during recovery.')
        }
        return saved.value
      })
    )
  }
  const page = readClaudeRecoveryFragmentPage(available, SLICE_BYTES, pending)
  if (page.next) {
    if (transfers.size >= CLAUDE_RECOVERY_CONCURRENCY) {
      throw new Error('Saved Claude history reader has no transfer slot.')
    }
    transfers.set(transferId, {
      prefix,
      key,
      canonicalItemId,
      revision,
      available,
      pending: page.pending
    })
  }
  const { fragments, next } = page
  return { fragments, next }
}

export function releaseJournalClaudeRecovery(
  db: Database.Database,
  transferId: string
): JournalClaudeRecoveryReadResult {
  transfersByReader.get(db)?.delete(transferId)
  return { kind: 'claude-recovery-release' }
}

export function readJournalClaudeRecovery(
  db: Database.Database,
  prefix: Prefix,
  history: () => JournalHistoryItemSource,
  operation: Exclude<
    JournalClaudeRecoveryRead,
    { kind: 'claude-recovery-release' | 'claude-recovery-goal' }
  >
): JournalClaudeRecoveryReadResult {
  switch (operation.kind) {
    case 'claude-recovery-fingerprints':
      requireClaudeRecoveryCursor(db, prefix, operation.cursor)
      return { kind: operation.kind, ...readFingerprints(history(), operation) }
    case 'claude-recovery-slices':
      return { kind: operation.kind, ...readSlices(db, prefix, history(), operation) }
    case 'claude-recovery-header':
      if (operation.cursor) {
        requireClaudeRecoveryCursor(db, prefix, operation.cursor)
      }
      return {
        kind: operation.kind,
        header: readClaudeRecoveryOriginHeader(db, prefix, operation.providerSessionId)
      }
    case 'claude-recovery-origin':
      requireClaudeRecoveryCursor(db, prefix, operation.cursor)
      return {
        kind: operation.kind,
        ...readClaudeRecoveryOriginIds(db, prefix, operation.after)
      }
  }
}
