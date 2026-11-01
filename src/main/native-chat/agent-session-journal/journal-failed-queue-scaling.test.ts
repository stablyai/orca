import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { readQueuePublication } from '../agent-session-wire/structured-agent-session-queued-publication'
import { StructuredAgentSessionCurrentWork } from '../agent-session-wire/structured-agent-session-current-work'
import { journalInputOrder } from './journal-input-order'
import { isolateJournalTransition } from './journal-reducer-transition'
import { failedQueueTurnSequence } from './queued-message-pause'
import type { JournalRow } from './journal-row-schema'

it.each([100, 1_000])(
  'checks failed-turn queue state without scanning %s history items',
  (size) => {
    const state = createJournalReducerState('session', 'epoch')
    const base = (seq: number) => ({ v: 4, epoch: 'epoch', seq, ts: seq, fence: 1 })
    for (let n = 1; n <= size; n++) {
      applyJournalRow(state, {
        ...base(n),
        kind: 'item',
        itemId: `message-${n}`,
        revision: 1,
        body: { kind: 'message', role: 'assistant', blocks: [] }
      })
    }
    const turn: JournalRow = {
      ...base(size + 1),
      kind: 'item',
      itemId: 'turn',
      revision: 1,
      body: { kind: 'turn', turnId: 'turn', state: 'running' }
    }
    applyJournalRow(state, turn)
    const order = journalInputOrder(state)
    expect(order.newestTurn.read()?.itemId).toBe('turn')
    // Drafts read the live map through keys(), so count every way of walking it.
    const walks = (['keys', 'values', 'entries', 'forEach', Symbol.iterator] as const).map(
      (method) => vi.spyOn(state.items, method)
    )
    const failed: JournalRow = {
      ...turn,
      ...base(size + 2),
      revision: 2,
      body: { kind: 'turn', turnId: 'turn', state: 'completed', outcome: 'failure' }
    }
    const pending = isolateJournalTransition(state, (draft) => applyJournalRow(draft, failed))
    expect(failedQueueTurnSequence(order.newestTurn.failure(), 0)).toBe(0)
    const committed = pending.adopt()
    for (let n = 0; n < 10; n++) {
      const owner = journalInputOrder(committed)
      expect(failedQueueTurnSequence(owner.newestTurn.failure(), 0)).toBe(size + 2)
      expect(owner.head(committed, null)).toBeUndefined()
    }
    for (const walk of walks) {
      expect(walk).not.toHaveBeenCalled()
      walk.mockRestore()
    }
    applyJournalRow(committed, {
      ...base(size + 3),
      kind: 'tombstone',
      itemId: 'turn',
      revision: 3
    })
    expect(journalInputOrder(committed).newestTurn.read()).toBeNull()
  }
)

it.each([100, 1_000])(
  'publishes a failure pause without walking %s recovered sends',
  async (size) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-failed-queue-scaling-'))
    const journals = createTrackedJournalOpener()
    const providerHandle = codexProviderHandle('thread')
    const body = { kind: 'message' as const, role: 'user' as const, blocks: [] }
    try {
      const journal = await journals.open({
        identity: { sessionId: 's', workspaceId: 'w', hostId: 'h', agent: 'codex', providerHandle },
        stateDirectory: root
      })
      await journal.queuedMessages.insert({ messageId: 'waiting', body })
      const state = journal.queuedMessages.inputState()
      let seq = state.lastSequence
      const base = () => ({ v: 4, epoch: state.epoch, seq: ++seq, ts: seq, fence: 1 })
      for (let n = 0; n < size; n++) {
        const clientMessageId = `old-${n}`
        applyJournalRow(state, {
          ...base(),
          kind: 'submission',
          clientMessageId,
          body,
          providerHandle,
          payloadFingerprint: clientMessageId,
          handoverRecorded: true
        })
        applyJournalRow(state, {
          ...base(),
          kind: 'dispatch',
          clientMessageId,
          state: 'unknown',
          reason: 'host_restarted_before_acknowledgement',
          providerItemId: null,
          recovered: true
        })
      }
      applyJournalRow(state, {
        ...base(),
        kind: 'item',
        itemId: 'turn',
        revision: 1,
        body: { kind: 'turn', turnId: 'turn', state: 'completed', outcome: 'failure' }
      })
      const work = new StructuredAgentSessionCurrentWork(journal, null)
      const gate = () => ({ record: null, work })
      const published = readQueuePublication(journal, gate)
      expect(published.queuePause).toEqual({ reason: 'failed' })
      // The working check walks entered sends on main already; this contract covers the pause.
      vi.spyOn(journal.inputOrder, 'enteredSubmissions').mockReturnValue([])
      // Count every read of a recovered send's state, however publication reaches it.
      let reads = 0
      for (const entry of state.submissions.values()) {
        const dispatchState = entry.dispatchState
        Object.defineProperty(entry, 'dispatchState', {
          get: () => (reads++, dispatchState),
          configurable: true,
          enumerable: true
        })
      }
      for (let n = 0; n < 10; n++) {
        expect(readQueuePublication(journal, gate)).toBe(published)
      }
      expect(reads).toBe(0)
    } finally {
      vi.restoreAllMocks()
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  }
)
