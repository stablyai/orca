import type { JournalReplacementItem } from './context-epochs/journal-epoch-replacement'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import { encodeAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record-stored-form'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { structuredAgentSessionForkBoundary } from '../agent-session-wire/acquisition/structured-agent-session-fork-boundary'
import { prepareForkSnapshot } from '../agent-session-wire/acquisition/structured-agent-session-fork-snapshot'
import { JournalForkPreparation } from './journal-fork-preparation'
import { JournalForkStages } from './journal-fork-stages'
import { messageFixture } from './journal-sql-message.test-fixture'
import { readJournalDomainForkBoundary } from './journal-domain-fork-reads'
import { JournalSqlScope } from './journal-sql-scope'
import { JournalSqlBatch } from './journal-sql-batch'
import { seedJournalForkSource } from './journal-fork-source.test-fixture'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { captureJournalMetadataPlans } from './journal-domain-metadata-plan.test-fixture'

it('releases a WAL-pressured capture before staging and leaves no visible fork after a pre-install crash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-sql-fork-'))
  const filename = join(directory, 'copy.sqlite')
  const writer = new Database(filename)
  let writerClosed = false
  writer.pragma('journal_mode=WAL')
  writer.pragma('wal_autocheckpoint=0')
  messageFixture(writer)
  let reader: Database.Database | undefined
  let preparation: JournalForkPreparation | undefined
  try {
    const record = agentSessionRecordFixture({
      sessionId: 'source-chat',
      provider: 'codex',
      providerHandleChain: [
        {
          linkId: 'head',
          origin: 'created',
          mintedAtFence: 1,
          observedAt: 1,
          handle: codexProviderHandle('source')
        }
      ]
    })
    writer
      .prepare('INSERT INTO agent_session_records(session_id,record_json) VALUES(?,?)')
      .run(record.sessionId, JSON.stringify(encodeAgentSessionRecord(record)))
    const items: AgentJournalRenderItem[] = [
      {
        itemId: agentJournalSubmissionKey('first-send'),
        revision: 1,
        sequence: 1,
        observedAt: 1,
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'Keep the frozen answer' }]
        }
      },
      {
        itemId: 'legacy:codex:source:root',
        revision: 1,
        sequence: 2,
        observedAt: 2,
        body: {
          kind: 'turn',
          turnId: 'T1',
          userItemId: agentJournalSubmissionKey('first-send'),
          state: 'completed'
        }
      }
    ]
    for (let ordinal = 1; ordinal <= 140; ordinal++) {
      items.push({
        itemId: `codex:source:T1:${ordinal}`,
        revision: 1,
        sequence: ordinal + 2,
        observedAt: ordinal + 2,
        turnScope: { kind: 'turn', turnItemId: 'legacy:codex:source:root' },
        body: {
          kind: 'message',
          role: 'assistant',
          ...(ordinal === 69 ? { state: 'running' as const } : {}),
          blocks: [
            {
              type: 'text',
              text: `frozen-${ordinal} ${'x'.repeat(8192)}`,
              ...([69, 130, 131].includes(ordinal)
                ? {
                    usageLimitTurnItemId: `codex:source:T1:${ordinal === 130 ? 69 : 130}`
                  }
                : {})
            }
          ]
        }
      })
    }
    const submissions: AgentJournalSubmission[] = [
      {
        clientMessageId: 'first-send',
        fence: 1,
        submittedAt: 1,
        submittedSequence: 1,
        payloadFingerprint: 'accepted-first-send',
        dispatchState: 'accepted',
        providerItemId: 'codex:source:T1:0',
        acceptedSequence: 1,
        reason: null,
        resolvedAt: 1
      }
    ]
    seedJournalForkSource(
      writer,
      {
        sessionId: 'source-chat',
        cursor: { epoch: 'epoch', sequence: 142 },
        items,
        submissions
      },
      record
    )
    writer.pragma('wal_checkpoint(TRUNCATE)')
    reader = new Database(filename)
    const source = readJournalDomainForkBoundary(
      new JournalSqlScope(writer, 'source-chat', 'epoch'),
      'codex:source:T1:140',
      undefined,
      false
    )
    const boundary = structuredAgentSessionForkBoundary(
      source.snapshot,
      record,
      'codex:source:T1:140'
    )!
    expect(boundary).not.toBeNull()
    const assertPlans = captureJournalMetadataPlans(
      reader,
      'SELECT item_id,sequence,sequence_index,ordinal,turn_item_id,'
    )
    preparation = new JournalForkPreparation(reader, {
      source: {
        sessionId: 'source-chat',
        throughItemId: 'codex:source:T1:140',
        capability: 'checkpoint',
        retained: boundary.retained,
        location: record.location,
        submissionsToken: null
      },
      sourceThreadId: 'source',
      childThreadId: 'child'
    })
    expect(preparation.next()).toEqual({ kind: 'progress', sourceReleased: false })
    writer
      .prepare(
        "UPDATE journal_items SET payload_json=json_set(payload_json,'$.body.blocks[0].text','new parent body') WHERE session_id='source-chat' AND item_id='codex:source:T1:140'"
      )
      .run()
    writer
      .prepare(
        "DELETE FROM journal_items WHERE session_id='source-chat' AND item_id='codex:source:T1:139'"
      )
      .run()
    const blocked = writer.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()!
    expect(Number(blocked.checkpointed)).toBeLessThan(Number(blocked.log))
    for (;;) {
      const step = preparation.next()
      expect(step.kind).toBe('progress')
      if (step.kind === 'progress' && step.sourceReleased) {
        break
      }
    }
    expect(reader.isTransaction).toBe(false)
    assertPlans()
    const released = writer.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()!
    expect(Number(released.checkpointed)).toBe(Number(released.log))
    const output: JournalReplacementItem[] = []
    for (;;) {
      const step = preparation.next()
      if (step.kind === 'complete') {
        break
      }
      if (step.kind === 'page') {
        expect(step.items.length).toBeLessThanOrEqual(64)
        expect(step.bytes).toBeLessThanOrEqual(1024 * 1024)
        output.push(...step.items)
      }
    }
    expect(
      output.filter(
        ({ identity }) => 'ordinal' in identity && [69, 130, 131].includes(identity.ordinal)
      )
    ).toEqual([])
    expect(output).toHaveLength(139)
    expect(output[0]!.identity).toEqual({
      provider: 'codex',
      threadId: 'child',
      turnId: 'T1',
      ordinal: 0
    })
    expect(output).toEqual(
      prepareForkSnapshot({
        snapshot: {
          sessionId: 'source-chat',
          cursor: { epoch: 'epoch', sequence: 142 },
          submissions,
          items
        },
        nextItemId: null,
        sourceThreadId: 'source',
        childThreadId: 'child'
      })
    )
    writer
      .prepare(
        "INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence) VALUES('workspace','child','empty',0,1)"
      )
      .run()
    const stages = new JournalForkStages(writer, directory)
    const batch = new JournalSqlBatch(writer, {
      beforeWrite: async () => {
        if (reader!.isTransaction) {
          throw new Error('checkpoint admission is waiting for capture')
        }
      },
      afterCommit: () => {}
    })
    const run = async (operation: Parameters<typeof stages.apply>[0]) => {
      const checkpoint = stages.checkpoint()
      const committed = await batch.run([operation], (op) => stages.apply(op, 150))
      const result = committed.outcomes[0]!
      if (!result.committed) {
        stages.rollback(checkpoint)
        throw result.error
      }
      stages.acknowledge()
      return result.value
    }
    const begun = await run({
      kind: 'fork-stage-begin',
      input: {
        target: { sessionId: 'child', epoch: 'empty', ownerToken: 'child-owner' },
        identity: {
          sessionId: 'child',
          workspaceId: 'workspace',
          hostId: 'local',
          agent: 'codex',
          providerHandle: codexProviderHandle('child')
        },
        fence: 1,
        operationId: 'create',
        fingerprint: 'fork-intent',
        source: {
          sessionId: 'source-chat',
          throughItemId: 'codex:source:T1:140',
          capability: 'checkpoint',
          retained: boundary.retained,
          location: record.location,
          submissionsToken: null
        }
      }
    })
    if (!begun || !('token' in begun)) {
      throw new Error('no private stage')
    }
    await run({
      kind: 'fork-stage-page',
      token: begun.token,
      ordinal: 0,
      items: output.slice(0, 64)
    })
    expect(
      writer
        .prepare(
          "SELECT COUNT(*) AS count FROM journal_items WHERE session_id='child' AND epoch<>'empty'"
        )
        .get()!.count
    ).toBeGreaterThan(0)
    preparation.close()
    preparation = undefined
    reader.close()
    reader = undefined
    writer.close()
    writerClosed = true
    // Reopening has no live stage authority; the old head and absent public receipt still win.
    const reopened = new Database(filename)
    try {
      expect(
        reopened.prepare("SELECT epoch FROM journal_chat_state WHERE session_id='child'").get()!
          .epoch
      ).toBe('empty')
      expect(
        reopened.prepare("SELECT 1 FROM agent_session_records WHERE session_id='child'").get()
      ).toBeUndefined()
      expect(
        reopened
          .prepare(
            "SELECT COUNT(*) AS count FROM journal_items item JOIN journal_chat_state head USING(session_id,epoch) WHERE item.session_id='child'"
          )
          .get()!.count
      ).toBe(0)
    } finally {
      reopened.close()
    }
  } finally {
    preparation?.close()
    reader?.close()
    if (!writerClosed) {
      writer.close()
    }
    await rm(directory, { recursive: true, force: true })
  }
})
