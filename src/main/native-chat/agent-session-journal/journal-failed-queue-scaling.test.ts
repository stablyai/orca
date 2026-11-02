import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
import {
  agentSessionJournalProviderHandle,
  codexProviderHandle
} from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { readQueuePublication } from '../agent-session-wire/structured-agent-session-queued-publication'
import { StructuredAgentSessionCurrentWork } from '../agent-session-wire/structured-agent-session-current-work'
import { journalInputOrder } from './journal-input-order'
import { isolateJournalTransition } from './journal-reducer-transition'
import { failedQueueTurnSequence } from './queued-message-pause'
import type { JournalRow } from './journal-row-schema'
import { JournalNewestTurn } from './journal-newest-turn'
import { structuredAgentSessionCommandTurn } from '../../../shared/agent-session/view/structured-agent-session-command-turn-identity'

function usageLimit(turnItemId: string) {
  return {
    kind: 'item',
    itemId: `limit:${turnItemId}`,
    revision: 1,
    body: { kind: 'status', text: 'Limit', tone: 'error', failure: { kind: 'usageLimitReached' } },
    turnScope: { kind: 'turn', turnItemId }
  } as const
}

/** Live failure position next to what a restore over the same items would derive. */
function failureFold() {
  const state = createJournalReducerState('session', 'epoch')
  const revisions = new Map<string, number>()
  const apply = (
    row: Omit<
      Extract<JournalRow, { kind: 'item' }>,
      'v' | 'epoch' | 'seq' | 'ts' | 'fence' | 'revision'
    >
  ) => {
    const revision = (revisions.get(row.itemId) ?? 0) + 1
    revisions.set(row.itemId, revision)
    const seq = state.lastSequence + 1
    applyJournalRow(state, { v: 4, epoch: 'epoch', seq, ts: seq, fence: 1, revision, ...row })
    return seq
  }
  const turn = (itemId: string, turnId = itemId, outcome: 'failure' | 'success' = 'failure') =>
    apply({ kind: 'item', itemId, body: { kind: 'turn', turnId, state: 'completed', outcome } })
  const command = (id: string) => {
    const { itemId, turnId } = structuredAgentSessionCommandTurn(id)
    return { itemId, settle: () => turn(itemId, turnId) }
  }
  return {
    state,
    apply,
    turn,
    command,
    live: () => journalInputOrder(state).newestTurn.failure(),
    restored: () => new JournalNewestTurn(state).failure() > 0
  }
}

describe('which failure holds the queue beneath refused commands', () => {
  it('releases when the failure beneath a refused command is revised to success', () => {
    const f = failureFold()
    const failedAt = f.turn('ordinary')
    f.command('refused').settle()
    expect(f.live()).toBe(failedAt)
    f.turn('ordinary', 'ordinary', 'success')
    expect([f.live(), f.restored()]).toEqual([0, false])
  })

  it("holds on an older command's late usage limit beneath a newer refused command", () => {
    const f = failureFold()
    const older = f.command('older')
    older.settle()
    f.command('newer').settle()
    expect(f.live()).toBe(0)
    const reported = f.apply(usageLimit(older.itemId))
    expect([f.live(), f.restored()]).toEqual([reported, true])
  })

  it('holds on a usage limit saved before its command turn row', () => {
    const f = failureFold()
    const command = f.command('out-of-order')
    f.apply(usageLimit(command.itemId))
    const settled = command.settle()
    expect([f.live(), f.restored()]).toEqual([settled, true])
  })

  it('leaves the live failure untouched when a draft adding its evidence is discarded', () => {
    const f = failureFold()
    const failedAt = f.turn('ordinary')
    const command = f.command('refused')
    command.settle()
    const pending = isolateJournalTransition(f.state, (draft) =>
      applyJournalRow(draft, {
        v: 4,
        epoch: 'epoch',
        seq: 9,
        ts: 9,
        fence: 1,
        ...usageLimit(command.itemId)
      })
    )
    expect(journalInputOrder(pending.state).newestTurn.failure()).toBe(9)
    expect(f.live()).toBe(failedAt)
  })
})

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
    // A command refused on its own terms, then the agent's late usage-limit row for it.
    const command = structuredAgentSessionCommandTurn('late')
    applyJournalRow(committed, {
      ...base(size + 3),
      kind: 'item',
      itemId: command.itemId,
      revision: 1,
      body: { kind: 'turn', turnId: command.turnId, state: 'completed', outcome: 'failure' }
    })
    expect(journalInputOrder(committed).newestTurn.failure()).toBe(size + 2)
    applyJournalRow(committed, { ...base(size + 4), ...usageLimit(command.itemId) })
    expect(journalInputOrder(committed).newestTurn.failure()).toBe(size + 4)
    for (const walk of walks) {
      expect(walk).not.toHaveBeenCalled()
      walk.mockRestore()
    }
    for (const itemId of [command.itemId, 'turn']) {
      applyJournalRow(committed, {
        ...base(committed.lastSequence + 1),
        kind: 'tombstone',
        itemId,
        revision: 3
      })
    }
    expect(journalInputOrder(committed).newestTurn.read()).toBeNull()
  }
)

it.each([100, 1_000])(
  'publishes a failure pause without walking %s recovered sends',
  async (size) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-failed-queue-scaling-'))
    const journals = createTrackedJournalOpener()
    const identity = {
      sessionId: 's',
      workspaceId: 'w',
      hostId: 'h',
      agent: 'codex' as const,
      providerHandle: codexProviderHandle('thread')
    }
    const providerHandle = agentSessionJournalProviderHandle(identity)
    const body = { kind: 'message' as const, role: 'user' as const, blocks: [] }
    try {
      const journal = await journals.open({
        identity,
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
