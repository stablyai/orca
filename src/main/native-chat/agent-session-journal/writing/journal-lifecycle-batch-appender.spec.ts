import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { JournalLifecycleBatchAppender } from './journal-lifecycle-batch-appender'
import { createJournalReducerState } from '../projection/journal-reducer'
import type { JournalLifecycleMutationInput } from './journal-lifecycle-mutation'
import '../durable-rows/journal-row-schema'
import type { JournalRow } from '../durable-rows/journal-row-schema'
import { createTrackedJournalOpener } from '../store-lifecycle/journal-host-database-test-support'
import type { AgentSessionJournal } from '../journal-store'

export function registerJournalLifecycleBatchAppenderTests(): void {
  function item(itemId: string, text = 'saved'): JournalLifecycleMutationInput {
    return {
      kind: 'item',
      itemId,
      body: { kind: 'status', text },
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  }

  const SESSION = 'repeated-items'
  const journals = createTrackedJournalOpener({ legacyInputs: true })
  let root: string
  let journal: AgentSessionJournal
  const options = () => ({
    identity: {
      sessionId: SESSION,
      workspaceId: 'folder',
      hostId: 'host',
      agent: 'codex' as const,
      providerHandle: codexProviderHandle('thread')
    },
    stateDirectory: root,
    now: () => 1_000
  })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-repeated-items-'))
    journal = await journals.open(options())
  })

  afterEach(async () => {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  it('does not skip an oversized repeat matching the saved body after an earlier planned change', async () => {
    const saved = { kind: 'status' as const, text: 'x'.repeat(1_500_001) }
    await journal.appendLifecycleBatch({
      settlementId: 'seed-saved',
      fence: 8,
      mutations: [item('saved', saved.text)]
    })
    await journal.appendLifecycleBatch({
      settlementId: 'restore-saved',
      fence: 8,
      mutations: [item('saved', 'changed'), item('saved', saved.text)]
    })
    expect(journal.snapshot().items).toMatchObject([{ itemId: 'saved', revision: 3, body: saved }])
  })

  it('advances alias and tombstone repeats across rows before re-adding the item', async () => {
    const identity = { provider: 'codex' as const, threadId: 'thread', turnId: 'turn', ordinal: 0 }
    await journal.appendSubmission({
      clientMessageId: 'saved',
      payloadFingerprint: 'fp',
      fence: 8,
      body: { kind: 'message', role: 'user', blocks: [] }
    })
    await journal.resolveDispatch({
      clientMessageId: 'saved',
      state: 'accepted',
      providerIdentity: identity,
      fence: 8
    })
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'saved' },
      { kind: 'status', text: 'seeded' },
      { fence: 8, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await journal.appendLifecycleBatch({
      settlementId: 'alias-repeats',
      fence: 8,
      mutations: [
        item('orca:saved', 'first'),
        ...Array.from({ length: 199 }, (_, index) => item(`filler-${index}`)),
        { kind: 'tombstone', identity },
        item('orca:saved', 'last')
      ]
    })
    expect(journal.snapshot().items.find((row) => row.itemId === 'orca:saved')).toMatchObject({
      revision: 4,
      body: { text: 'last' }
    })
  })

  describe('resolved lifecycle planning', () => {
    it.each(['chunks', 'oversized', 'alias'] as const)(
      'rejects repeated items across %s before any row is written',
      (repeatedAs) => {
        const state = createJournalReducerState('session', 'epoch')
        state.aliases.set('alias', 'saved')
        const rows: JournalRow[] = []
        const appender = new JournalLifecycleBatchAppender({
          state: () => state,
          cursor: () => ({ epoch: state.epoch, sequence: state.lastSequence }),
          enqueueRows: async (plan) => {
            const built = plan().map((build, index) => build(index + 1, 1_000))
            rows.push(...built)
            return built
          }
        })
        const mutations = [
          item('saved', repeatedAs === 'oversized' ? 'x'.repeat(1_500_001) : 'first'),
          ...Array.from({ length: 200 }, (_, index) => item(`filler-${index}`)),
          repeatedAs === 'alias'
            ? { kind: 'tombstone' as const, itemId: 'alias' }
            : item('saved', 'second')
        ]
        expect(() =>
          appender.planResolved({ settlementId: 'settlement', fence: 8, resolve: () => mutations })
        ).toThrow('journal_resolved_lifecycle_batch_names_item_twice')
        expect(rows).toEqual([])
        expect(state.items.size).toBe(0)
        expect(state.lastSequence).toBe(0)
      }
    )
  })
}
