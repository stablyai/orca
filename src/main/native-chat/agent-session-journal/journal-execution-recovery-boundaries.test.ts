import { afterEach, beforeEach, it, expect, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { settleStaleStructuredAgentSessionState } from '../agent-session-wire/structured-agent-session-stale-state-settlement'
import { journalInputOrder } from './journal-input-order'
import { latestUsageLimitContinueIdentity } from '../../../shared/native-chat/native-chat-usage-limit-cut'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
const turn = { provider: 'claude' as const, sessionId: 'thread', uuid: 'turn-B' }
const options = { fence: 0, turnScope: { kind: 'thread' as const } }
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-03T12:00:00Z'))
})
afterEach(() => vi.useRealTimers())
async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), 'pr37743-close4-independent-'))
  const journals = createTrackedJournalOpener()
  const input = {
    identity: {
      sessionId: name,
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'claude' as const,
      providerHandle: claudeProviderHandle('thread', null)
    },
    stateDirectory: root
  }
  let journal = await journals.open(input)
  return {
    get journal() {
      return journal
    },
    async restart() {
      await journals.closeAll()
      journal = await journals.open(input)
    },
    async dispose() {
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  }
}
import { settleUnheldStructuredAgentSessionTurns } from '../agent-session-wire/structured-agent-session-unheld-turns'
it('a queued exact old-host callback cannot settle a fresh same-child execution', async () => {
  const f = await fixture('real-unheld-caller')
  const old = agentJournalItemKey(turn)
  try {
    await f.journal.appendItem(turn, { kind: 'turn', turnId: 'B', state: 'running' }, options)
    await f.journal.appendSubmission({
      clientMessageId: 'fresh',
      payloadFingerprint: 'fresh',
      body: { kind: 'message', role: 'user', blocks: [] },
      fence: 0,
      handoverRecorded: true
    })
    await f.journal.resolveDispatch({
      clientMessageId: 'fresh',
      state: 'pending',
      fence: 0,
      turnScope: { kind: 'thread' }
    })
    let queued: Promise<unknown>[] = []
    const detach = f.journal.observeCommits((rows) => {
      if (!rows?.some((row) => row.kind === 'item' && row.itemId === 'orca:capture-gate')) {
        return
      }
      queued = [
        f.journal.appendItem(
          turn,
          { kind: 'turn', turnId: 'B', state: 'completed', outcome: 'success' },
          options
        ),
        f.journal.appendItem(
          turn,
          {
            kind: 'turn',
            turnId: 'B',
            state: 'running',
            userItemId: agentJournalSubmissionKey('fresh')
          },
          { ...options, executionOwner: 0 }
        ),
        f.journal.appendLifecycleBatch({
          settlementId: 'remove-exact-old',
          fence: 0,
          mutations: [{ kind: 'tombstone', itemId: old }]
        }),
        settleUnheldStructuredAgentSessionTurns(f.journal, 'real-unheld-caller', 0, 'old-end', null)
      ]
    })
    await f.journal.appendItem(
      { provider: 'orca', clientMessageId: 'capture-gate' },
      { kind: 'status', text: 'gate' },
      options
    )
    detach()
    await Promise.all(queued)
    const fresh = f.journal.canonicalItemId(old)
    const facts = { freshId: fresh, old: f.journal.itemBody(old), fresh: f.journal.itemBody(fresh) }
    expect(fresh).not.toBe(old)
    expect(facts.old).toBeNull()
    expect(facts.fresh).toMatchObject({ state: 'running' })
    await f.restart()
    expect(f.journal.itemBody(fresh)).toMatchObject({ state: 'running' })
    expect(f.journal.itemBody(old)).toBeNull()
  } finally {
    await f.dispose()
  }
})
it('matching post-Stop death retires a displaced execution through production restart recovery', async () => {
  const f = await fixture('death-control')
  const old = agentJournalItemKey(turn)
  try {
    await f.journal.appendItem(turn, { kind: 'turn', turnId: 'B', state: 'running' }, options)
    await f.journal.appendStopEvent({ reason: 'user-stop', turnId: 'B' }, 0)
    await f.journal.appendItem(
      turn,
      { kind: 'turn', turnId: 'B', state: 'running' },
      { ...options, fence: 1, executionOwner: 1 }
    )
    const fresh = f.journal.canonicalItemId(old)
    await f.restart()
    const result = await settleStaleStructuredAgentSessionState({
      journal: f.journal,
      sessionId: 'death-control',
      fence: 1,
      below: 1,
      acquisitionGeneration: 'restart',
      deathEvidence: {
        kind: 'exit-observed',
        ownerFence: 0,
        observedAt: Date.now() + 1000,
        detail: ''
      }
    })
    await f.restart()
    const facts = {
      result,
      old: f.journal.itemBody(old),
      fresh: f.journal.itemBody(fresh),
      pending: f.journal.stopMarks.cancellations()
    }
    expect(facts.old).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    expect(facts.fresh).toMatchObject({ state: 'running' })
    expect(facts.pending).toEqual([])
  } finally {
    await f.dispose()
  }
})
it('Stop does not acquire historical intent for a source absent from the eligible public cut', async () => {
  const f = await fixture('hidden-historical-cut')
  const old = agentJournalItemKey(turn)
  try {
    await f.journal.appendItem(
      turn,
      { kind: 'turn', turnId: 'B', state: 'completed', outcome: 'failure' },
      options
    )
    await f.journal.appendItem(
      { provider: 'orca', clientMessageId: 'limit' },
      {
        kind: 'status',
        ...agentSessionFailureWords(
          agentSessionFailureFact('usageLimitReached', { usageLimit: { resetsAt: 5000 } }),
          { surface: 'row' }
        )
      },
      { fence: 0, turnScope: { kind: 'turn', turnItemId: old } }
    )
    await f.journal.appendItem(
      turn,
      { kind: 'turn', turnId: 'B', state: 'completed', outcome: 'success' },
      { ...options, fence: 1, executionOwner: 1 }
    )
    await f.journal.appendTombstone(turn, { fence: 1 })
    await f.restart()
    expect(latestUsageLimitContinueIdentity(f.journal.snapshot())).toBeUndefined()
    expect(f.journal.stopMarks.userStopRequestedForItem(old)).toBe(false)
    await f.journal.appendStopEvent({ reason: 'user-stop' }, 1)
    await f.restart()
    const facts = {
      visible: latestUsageLimitContinueIdentity(f.journal.snapshot()),
      indexed: journalInputOrder(
        f.journal.queuedMessages.inputState()
      ).newestTurn.usageLimitCut.read(),
      oldStop: f.journal.stopMarks.userStopRequestedForItem(old),
      pending: f.journal.stopMarks.cancellations()
    }
    expect(facts.oldStop).toBe(false)
  } finally {
    await f.dispose()
  }
})

it.each([false, true])(
  'hidden owners settle without adding recovery rows (stopped=%s)',
  async (stopped) => {
    const f = await fixture(`silent-${stopped}`)
    const old = agentJournalItemKey(turn)
    try {
      await f.journal.appendItem(turn, { kind: 'turn', turnId: 'B', state: 'running' }, options)
      if (stopped) {
        await f.journal.appendStopEvent({ reason: 'user-stop', turnId: 'B' }, 0)
      }
      await f.journal.appendItem(
        turn,
        { kind: 'turn', turnId: 'B', state: 'completed', outcome: 'success' },
        { ...options, fence: 1, executionOwner: 1 }
      )
      const visible = f.journal.snapshot().items
      await settleStaleStructuredAgentSessionState({
        journal: f.journal,
        sessionId: `silent-${stopped}`,
        fence: 1,
        below: 1,
        acquisitionGeneration: 'silent-death',
        deathEvidence: {
          kind: 'exit-observed',
          ownerFence: 0,
          observedAt: Date.now() + 1000,
          detail: ''
        }
      })
      expect(f.journal.itemBody(old)).toMatchObject({ state: 'interrupted' })
      expect(f.journal.snapshot().items).toEqual(visible)
      await f.restart()
      expect(f.journal.snapshot().items).toEqual(visible)
    } finally {
      await f.dispose()
    }
  }
)

it('a removed replacement never reveals its earlier owner after exact settlement and epoch carry', async () => {
  const f = await fixture('removed-displacer')
  const old = agentJournalItemKey(turn)
  try {
    await f.journal.appendItem(turn, { kind: 'turn', turnId: 'B', state: 'running' }, options)
    await f.journal.appendItem(
      turn,
      { kind: 'turn', turnId: 'B', state: 'completed', outcome: 'success' },
      { ...options, fence: 1, executionOwner: 1 }
    )
    await f.journal.appendTombstone(turn, { fence: 1 })
    await settleStaleStructuredAgentSessionState({
      journal: f.journal,
      sessionId: 'removed-displacer',
      fence: 1,
      below: 1,
      acquisitionGeneration: 'hidden-death',
      deathEvidence: {
        kind: 'exit-observed',
        ownerFence: 0,
        observedAt: Date.now() + 1000,
        detail: ''
      }
    })
    expect(f.journal.itemBody(old)).toMatchObject({ state: 'interrupted' })
    expect(f.journal.snapshot().items).toEqual([])
    await f.restart()
    await f.journal.replaceEpochItems('handle_forked', 1, [])
    expect(f.journal.itemBody(old)).toMatchObject({ state: 'interrupted' })
    expect(f.journal.snapshot().items).toEqual([])
    await f.restart()
    expect(f.journal.itemBody(old)).toMatchObject({ state: 'interrupted' })
    expect(f.journal.snapshot().items).toEqual([])
    expect(
      journalInputOrder(f.journal.queuedMessages.inputState()).newestTurn.usageLimitCut.read()
    ).toBeUndefined()
  } finally {
    await f.dispose()
  }
})
