import { it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
import { readAgentSessionHistory } from '../agent-session-wire/agent-session-history-page'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import {
  agentJournalSubmissionKey,
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'

for (const nextFence of [0, 1]) {
  it(`a replaced execution cannot inherit the retained Stop (next fence=${nextFence})`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pr37743-close3-reuse-'))
    const journals = createTrackedJournalOpener()
    const input = {
      identity: {
        sessionId: 'reuse',
        workspaceId: 'folder',
        hostId: 'local',
        agent: 'claude' as const,
        providerHandle: claudeProviderHandle('thread', null)
      },
      stateDirectory: root
    }
    let journal = await journals.open(input)
    const identity = { provider: 'claude' as const, sessionId: 'thread', uuid: 'turn-B' }
    try {
      await journal.appendItem(
        identity,
        { kind: 'turn', turnId: 'B', state: 'running' },
        { fence: 0, turnScope: { kind: 'thread' } }
      )
      await journal.appendStopEvent({ reason: 'user-stop', turnId: 'B' }, 0)
      await journal.appendItem(
        identity,
        { kind: 'turn', turnId: 'B', state: 'completed', outcome: 'failure' },
        { fence: 0, turnScope: { kind: 'thread' } }
      )
      expect(journal.stopMarks.cancellations()).toEqual([])
      await journal.appendSubmission({
        clientMessageId: 'fresh',
        payloadFingerprint: 'fresh',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'new report' }] },
        fence: nextFence,
        handoverRecorded: true
      })
      await journal.resolveDispatch({
        clientMessageId: 'fresh',
        state: 'pending',
        fence: nextFence,
        turnScope: { kind: 'thread' }
      })
      const replacementCursor = journal.cursor()
      await journal.appendItem(
        identity,
        {
          kind: 'turn',
          turnId: 'B',
          state: 'running',
          userItemId: agentJournalSubmissionKey('fresh')
        },
        { fence: nextFence, executionOwner: nextFence, turnScope: { kind: 'thread' } }
      )
      const oldId = agentJournalItemKey(identity)
      const freshId = journal.canonicalItemId(oldId)
      expect(freshId).not.toBe(oldId)
      const update = readAgentSessionHistory(journal, {
        sessionId: 'reuse',
        direction: 'after',
        cursor: replacementCursor,
        limit: 50
      })
      expect(update.ok).toBe(true)
      if (!update.ok) {
        throw new Error('expected replacement page')
      }
      expect(update.page.removedItemIds).toContain(oldId)
      expect(update.page.items.map((item) => item.itemId)).toContain(freshId)
      await journal.appendLifecycleBatch({
        settlementId: 'late-old-running',
        fence: nextFence,
        mutations: [
          {
            kind: 'item',
            itemId: oldId,
            body: { kind: 'turn', turnId: 'B', state: 'running' },
            ownerFence: 0,
            turnScope: { kind: 'thread' }
          }
        ]
      })
      expect(journal.itemBody(oldId)).toMatchObject({ outcome: 'failure' })
      expect(journal.itemBody(freshId)).toMatchObject({ state: 'running' })
      const before = journal.stopMarks.cancellations()
      const visibleTurns = journal.snapshot().items.filter((item) => item.body.kind === 'turn')
      expect(visibleTurns).toHaveLength(1)
      const history = journal.stopMarks.userStopRequestedForItem(visibleTurns[0].itemId)
      const originals = [...journal.queuedMessages.inputState().items.values()].filter(
        (item) => item.body.kind === 'turn' && item.body.outcome === 'failure'
      )
      expect(originals).toHaveLength(1)
      expect(journal.stopMarks.userStopRequestedForItem(originals[0].itemId)).toBe(true)
      await journals.closeAll()
      journal = await journals.open(input)
      expect({ before, history, after: journal.stopMarks.cancellations() }).toEqual({
        before: [],
        history: false,
        after: []
      })
      const retained = journal.snapshot().items.map((item) => {
        const identity = parseAgentJournalItemKey(item.itemId)
        if (!identity) {
          throw new Error('invalid test item identity')
        }
        return {
          ...item,
          identity,
          ...journal.itemProvenance(item.itemId),
          ownerFence: journal.itemFence(item.itemId) ?? 0
        }
      })
      await journal.replaceEpochItems('handle_forked', nextFence, retained)
      await journals.closeAll()
      journal = await journals.open(input)
      expect(journal.stopMarks.cancellations()).toEqual([])
      expect(journal.stopMarks.userStopRequestedForItem(oldId)).toBe(true)
      expect(journal.stopMarks.userStopRequestedForItem(freshId)).toBe(false)
      expect(journal.itemBody(oldId)).toMatchObject({ outcome: 'failure' })
      await journal.appendSubmission({
        clientMessageId: 'third',
        payloadFingerprint: 'third',
        body: { kind: 'message', role: 'user', blocks: [] },
        fence: nextFence
      })
      await journal.appendItem(
        identity,
        {
          kind: 'turn',
          turnId: 'B',
          state: 'running',
          userItemId: agentJournalSubmissionKey('third')
        },
        { fence: nextFence, executionOwner: nextFence, turnScope: { kind: 'thread' } }
      )
      const thirdId = journal.canonicalItemId(oldId)
      expect(thirdId).not.toBe(freshId)
      expect(
        journal
          .snapshot()
          .items.filter((item) => item.body.kind === 'turn')
          .map((item) => item.itemId)
      ).toEqual([thirdId])
      await journals.closeAll()
      journal = await journals.open(input)
      expect(
        journal
          .snapshot()
          .items.filter((item) => item.body.kind === 'turn')
          .map((item) => item.itemId)
      ).toEqual([thirdId])
      expect(journal.stopMarks.userStopRequestedForItem(oldId)).toBe(true)
      expect(journal.stopMarks.userStopRequestedForItem(thirdId)).toBe(false)
    } finally {
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  })
}

it('a new execution owner reusing a removed provider turn remains stoppable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pr37743-close3-remove-reuse-'))
  const journals = createTrackedJournalOpener()
  const input = {
    identity: {
      sessionId: 'remove-reuse',
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'claude' as const,
      providerHandle: claudeProviderHandle('thread', null)
    },
    stateDirectory: root
  }
  let journal = await journals.open(input)
  const identity = { provider: 'claude' as const, sessionId: 'thread', uuid: 'turn-B' }
  try {
    await journal.appendItem(
      identity,
      { kind: 'turn', turnId: 'B', state: 'running' },
      { fence: 0, turnScope: { kind: 'thread' } }
    )
    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'B' }, 0)
    await journal.appendTombstone(identity, { fence: 0 })
    await journal.appendItem(
      identity,
      { kind: 'turn', turnId: 'B', state: 'running' },
      { fence: 1, executionOwner: 1, turnScope: { kind: 'thread' } }
    )
    expect(journal.stopMarks.cancellations()).toEqual([])
    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'B' }, 1)
    const before = journal.stopMarks.personStopDecides('B')
    await journals.closeAll()
    journal = await journals.open(input)
    await journal.appendItem(
      identity,
      { kind: 'turn', turnId: 'B', state: 'running' },
      {
        fence: 1,
        executionOwner: 0,
        turnScope: { kind: 'thread' }
      }
    )
    expect(journal.snapshot().items.filter((item) => item.body.kind === 'turn')).toHaveLength(1)
    expect({ before, after: journal.stopMarks.personStopDecides('B') }).toEqual({
      before: true,
      after: true
    })
  } finally {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  }
})

it('an exact late completion advances the retained execution revision rather than its replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pr37743-exact-completion-'))
  const journals = createTrackedJournalOpener()
  const journal = await journals.open({
    identity: {
      sessionId: 'exact-completion',
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('thread', null)
    },
    stateDirectory: root
  })
  const identity = { provider: 'claude' as const, sessionId: 'thread', uuid: 'turn-B' }
  const oldId = agentJournalItemKey(identity)
  try {
    for (let i = 0; i < 5; i++) {
      await journal.appendItem(
        identity,
        { kind: 'turn', turnId: 'B', state: 'running' },
        { fence: 0, turnScope: { kind: 'thread' } }
      )
    }
    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'B' }, 0)
    await journal.appendItem(
      identity,
      { kind: 'turn', turnId: 'B', state: 'running' },
      { fence: 1, executionOwner: 1, turnScope: { kind: 'thread' } }
    )
    const freshId = journal.canonicalItemId(oldId)
    expect(freshId).not.toBe(oldId)
    await journal.appendLifecycleBatch({
      settlementId: 'exact-old-observation',
      fence: 1,
      mutations: [
        {
          kind: 'item',
          itemId: oldId,
          body: { kind: 'turn', turnId: 'B', state: 'unverifiable' },
          ownerFence: 0,
          turnScope: { kind: 'thread' }
        }
      ]
    })
    await journal.appendLifecycleBatch({
      settlementId: 'exact-old-completion',
      fence: 1,
      mutations: [
        {
          kind: 'item',
          itemId: oldId,
          body: { kind: 'turn', turnId: 'B', state: 'interrupted' },
          ownerFence: 0,
          turnScope: { kind: 'thread' }
        }
      ]
    })
    expect(journal.itemBody(oldId)).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    expect(journal.itemBody(freshId)).toMatchObject({ state: 'running' })
    expect(journal.stopMarks.cancellations()).toEqual([])
  } finally {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  }
})
