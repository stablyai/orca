import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { JournalHostDatabase } from './journal-host-database'
import { readContextTransfers, writeContextTransfer } from './context-transfer-repository'
import type { ContextTransferHandoff } from './context-transfer-record'
import type {
  AgentJournalSubmission,
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalMessageItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { captureRecoveryContext } from './context-transfer-capture'
import { selectRecoveryDelivery, withRecoveryContext } from '../agent-session-context-transfer-text'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerCommandReceiptSchemaTests } from './command-receipt-schema.spec'
import { registerCommandReceiptTableTests } from './command-receipt-table.spec'
import { registerCommandReceiptTransactionTests } from './command-receipt-transaction.spec'
import { registerJournalDatabaseTests } from './journal-database.spec'
import { registerJournalHostDatabaseTests } from './journal-host-database.spec'
import { registerJournalRowWriterTests } from './journal-row-writer.spec'
import { registerJournalWriteQueueTests } from './journal-write-queue.spec'
import { registerJournalStoreSchemaTests } from './journal-store-schema.spec'
import { registerJournalRowSchemaVersionTests } from './journal-row-schema-version.spec'

afterEach(() => vi.restoreAllMocks())

describe('command-receipt-schema', registerCommandReceiptSchemaTests)
describe('command-receipt-table', registerCommandReceiptTableTests)
describe('command-receipt-transaction', registerCommandReceiptTransactionTests)
describe('journal-database', registerJournalDatabaseTests)
describe('journal-host-database', registerJournalHostDatabaseTests)
describe('journal-row-writer', registerJournalRowWriterTests)
describe('journal-write-queue', registerJournalWriteQueueTests)
describe('journal-store-schema', registerJournalStoreSchemaTests)
describe('journal-row-schema-version', registerJournalRowSchemaVersionTests)

describe('native context transfer persistence', () => {
  it('keeps frozen source across reopen and preserves unreadable records while refusing only their chat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-transfer-31973-'))
    let database = JournalHostDatabase.open(root)
    try {
      const handoff: ContextTransferHandoff = {
        kind: 'handoff',
        id: 'handoff',
        handoffId: 'handoff',
        sessionId: 'source',
        sourceLink: {
          linkId: 'original',
          handle: { transport: 'codex-app-server', agent: 'codex', nativeId: 'thread' },
          origin: 'created',
          mintedAtFence: 1,
          observedAt: 1
        },
        sourceCursor: { epoch: 'retired', sequence: 20 },
        contextFloor: null,
        trigger: 'codex-no-rollout',
        capturedAt: 1,
        capture: {
          selectionVersion: 1,
          messages: [
            {
              itemId: 'saved',
              revision: 2,
              sequence: 10,
              sequenceIndex: 0,
              role: 'assistant',
              kind: 'message',
              text: 'Remember the decision'
            }
          ],
          coverage: {
            eligibleCount: 1,
            omittedCount: 0,
            firstItemId: 'saved',
            lastItemId: 'saved',
            inventoryDigest: 'digest'
          }
        }
      }
      database.transaction((db) => writeContextTransfer(db, handoff))
      await database.close()
      database = JournalHostDatabase.open(root)
      expect(database.db.pragma('user_version', { simple: true })).toBe(5)
      expect(readContextTransfers(database.db, 'source')).toEqual([handoff])
      database.db
        .prepare('INSERT INTO agent_session_context_transfers VALUES (?,?,?,?,?,?)')
        .run('future', 'other', 'future', 'handoff', 2, '{"opaque":true}')
      expect(() => readContextTransfers(database.db, 'other')).toThrow()
      expect(readContextTransfers(database.db, 'source')).toEqual([handoff])
      expect(
        database.db
          .prepare('SELECT record_json FROM agent_session_context_transfers WHERE id = ?')
          .get('future')?.record_json
      ).toBe('{"opaque":true}')
      expect(() =>
        database.transaction((db) =>
          writeContextTransfer(db, { ...handoff, capture: { ...handoff.capture, messages: [] } })
        )
      ).toThrow('Frozen context changed')
      expect(readContextTransfers(database.db, 'source')).toEqual([handoff])
    } finally {
      await database.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('excludes unknown and unhanded input aliases and budgets intact source without changing the carrier', () => {
    const accepted = (
      id: string,
      dispatchState: 'accepted' | 'unknown' | 'pending'
    ): AgentJournalSubmission => ({
      clientMessageId: id,
      fence: 1,
      payloadFingerprint: id,
      dispatchState,
      providerItemId: id === 'unknown' ? 'native-unknown' : null,
      reason: null,
      submittedAt: 1,
      resolvedAt: null
    })
    const item = (
      id: string,
      text: string,
      role: 'user' | 'assistant',
      sequence: number
    ): AgentJournalRenderItem => ({
      itemId: id,
      revision: 1,
      sequence,
      observedAt: 1,
      body: { kind: 'message', role, blocks: [{ type: 'text', text }] }
    })
    const snapshot: AgentJournalSnapshot = {
      sessionId: 'source',
      cursor: { epoch: 'one', sequence: 9 },
      items: [
        item(agentJournalSubmissionKey('accepted'), 'Remember "A" \\ B', 'user', 1),
        item('reply', 'Confirmed A', 'assistant', 2),
        item('native-unknown', 'Do not replay me', 'user', 3),
        item(agentJournalSubmissionKey('queued'), 'Do not replay queued', 'user', 4)
      ],
      submissions: [
        accepted('accepted', 'accepted'),
        accepted('unknown', 'unknown'),
        accepted('queued', 'pending')
      ]
    }
    const source = captureRecoveryContext(snapshot, (id) =>
      id === 'native-unknown' ? agentJournalSubmissionKey('unknown') : id
    )
    expect(source.capture.messages.map((message) => message.itemId)).toEqual([
      agentJournalSubmissionKey('accepted'),
      'reply'
    ])
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Exactly typed' }]
    }
    const before = JSON.stringify(body)
    const selection = selectRecoveryDelivery({ id: 'delivery', capture: source.capture, body })
    const dispatched = withRecoveryContext(body, selection.encodedContext)
    expect(JSON.stringify(body)).toBe(before)
    expect(dispatched.blocks).toContainEqual({ type: 'text', text: 'Exactly typed' })
    expect(selection.encodedContext).toContain('Remember "A" \\ B')
    expect(selection.encodedContext).not.toContain('Do not replay')
    expect(Buffer.byteLength(JSON.stringify(dispatched))).toBeLessThan(64_000)
    expect(() =>
      selectRecoveryDelivery({
        id: 'small',
        capture: source.capture,
        body,
        encodedInputBytes: 8 * 1024 * 1024 - 100,
        encodedLimit: 8 * 1024 * 1024
      })
    ).toThrow('does not fit')
  })
})
