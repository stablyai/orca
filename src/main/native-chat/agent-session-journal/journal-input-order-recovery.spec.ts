import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
import { holdUnsentSends } from './journal-unsent-send-hold'
import {
  selectedStructuredSubmission,
  selectStructuredAgentSessionInput
} from '../agent-session-wire/structured-agent-session-input-selection'

const message = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

it('keeps the released native boundary when a warm close recovers before another Stop', async () => {
  const pauses = 1
  const root = await mkdtemp(join(tmpdir(), 'orca-warm-recovery-order-'))
  const journals = createTrackedJournalOpener()
  const journal = await journals.open({
    identity: {
      sessionId: 'settled',
      workspaceId: 'folder',
      hostId: 'ssh',
      agent: 'claude',
      providerHandle: claudeProviderHandle('thread', null)
    },
    stateDirectory: root
  })
  try {
    await journal.queuedMessages.insert({
      messageId: 'C',
      body: { ...message('/compact'), command: { name: 'compact' } }
    })
    await journal.queuedMessages.insert({ messageId: 'A', body: message('old waiting') })
    const sent = await journal.queuedMessages.insert({ messageId: 'S', body: message('sent') })
    await journal.appendSubmission(
      {
        clientMessageId: 'sent-S',
        body: sent.body,
        payloadFingerprint: sent.fingerprint,
        fence: 0,
        handoverRecorded: true,
        origin: 'client'
      },
      { messageId: 'S', expect: 'waiting' }
    )
    await journal.resolveDispatch({
      clientMessageId: 'sent-S',
      state: 'accepted',
      providerIdentity: null,
      fence: 0
    })
    expect(journal.inputOrder.lineage.cards.has('S')).toBe(false)
    for (let n = 0; n < pauses; n++) {
      await journal.appendStopEvent({ reason: 'user-stop' }, 0)
      journal.queuedMessages.nextInputCard()
      await journal.appendQueueResume(0)
      journal.queuedMessages.nextInputCard()
    }
    await journal.appendSubmission({
      clientMessageId: 'M',
      body: message('unhanded direct send'),
      options: { effort: 'high' },
      payloadFingerprint: 'M',
      fence: 0,
      handoverRecorded: true,
      origin: 'client'
    })
    expect(journal.inputOrder.forced('M')).toBe(true)
    await journal.queuedMessages.insert({
      messageId: 'L',
      body: message('newer card'),
      options: { effort: 'low' }
    })
    await journal.queuedMessages.move({ messageId: 'L', beforeMessageId: 'A' })
    await journal.queuedMessages.withdraw(['A'])
    const stop = journal.queuedMessages.inputState().queuePauseMarks.latestStop
    const state = journal.queuedMessages.inputState()
    expect(journal.inputOrder.predecessors(state, 'M').position).toBe(3)
    const submitted = journal.submission('M')!
    expect(selectStructuredAgentSessionInput(journal)).toMatchObject({
      kind: 'card',
      card: { messageId: 'C' }
    })
    expect(journal.queuedMessages.pauses()).toEqual([])
    expect(
      await holdUnsentSends(journal, { fence: 0, hold: { cause: 'chatClosed' } })
    ).not.toBeNull()
    expect(journal.queuedMessages.inputState().queuePauseMarks.latestStop).toEqual(stop)
    expect(
      journal.queuedMessages.list().map((card) => ({
        id: card.messageId,
        position: card.position,
        state: card.state,
        body: card.body,
        options: card.options,
        consumedAs: card.consumedAs,
        recovers: card.recovers,
        holdReason: card.holdReason,
        returnedReason: card.returnedReason,
        returnedRejection: card.returnedRejection
      }))
    ).toEqual([
      {
        id: 'C',
        position: 0,
        state: 'waiting',
        body: { ...message('/compact'), command: { name: 'compact' } },
        options: undefined,
        consumedAs: null,
        recovers: undefined,
        holdReason: null,
        returnedReason: null,
        returnedRejection: null
      },
      {
        id: 'L',
        position: 1,
        state: 'waiting',
        body: message('newer card'),
        options: { effort: 'low' },
        consumedAs: null,
        recovers: undefined,
        holdReason: null,
        returnedReason: null,
        returnedRejection: null
      },
      {
        id: 'M',
        position: 2,
        state: 'waiting',
        body: message('unhanded direct send'),
        options: { effort: 'high' },
        consumedAs: null,
        recovers: undefined,
        holdReason: null,
        returnedReason: null,
        returnedRejection: null
      }
    ])
    expect(journal.queuedMessages.get('M')?.queuedAt).toEqual({
      epoch: journal.physicalCursor().epoch,
      sequence: submitted.submittedSequence
    })
    expect(journal.submission('M')).toMatchObject({
      dispatchState: 'rejected',
      rejection: { kind: 'chatClosed' },
      keptAsQueuedMessageId: 'M',
      options: { effort: 'high' },
      recovered: true
    })
    expect(journal.submission('M')?.queuedMessageId).toBeUndefined()
    expect(journal.queuedMessages.get('S')).toMatchObject({
      state: 'dispatched',
      consumedAs: 'sent-S',
      position: 3,
      body: message('sent')
    })
    expect(journal.submission('sent-S')).toMatchObject({
      dispatchState: 'accepted',
      queuedMessageId: 'S'
    })
    expect(journal.queuedMessages.get('A')).toMatchObject({
      state: 'withdrawn',
      position: 4,
      body: message('old waiting')
    })
    expect(journal.queuedMessages.pauses()).toEqual([])
    expect(journal.queuedMessages.nextInputCard()?.messageId).toBe('C')
    expect(selectStructuredAgentSessionInput(journal)).toMatchObject({
      kind: 'card',
      card: { messageId: 'C' }
    })
    expect(selectedStructuredSubmission(journal)).toBeUndefined()
  } finally {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps a native introduction released after a pause until the following pause', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-late-settled-order-'))
  const journals = createTrackedJournalOpener()
  const journal = await journals.open({
    identity: {
      sessionId: 'late-settled',
      workspaceId: 'folder',
      hostId: 'ssh',
      agent: 'claude',
      providerHandle: claudeProviderHandle('thread', null)
    },
    stateDirectory: root
  })
  try {
    await journal.queuedMessages.insert({
      messageId: 'C',
      body: { ...message('/compact'), command: { name: 'compact' } }
    })
    const card = await journal.queuedMessages.insert({ messageId: 'S', body: message('sent') })
    await journal.appendSubmission(
      {
        clientMessageId: 'sent-S',
        body: card.body,
        payloadFingerprint: card.fingerprint,
        fence: 0,
        handoverRecorded: true,
        origin: 'client'
      },
      { messageId: 'S', expect: 'waiting' }
    )
    await journal.appendSubmission({
      clientMessageId: 'M',
      body: message('unhanded direct send'),
      payloadFingerprint: 'M',
      fence: 0,
      handoverRecorded: true,
      origin: 'client'
    })
    const position = () =>
      journal.inputOrder.predecessors(journal.queuedMessages.inputState(), 'M').position
    expect(position()).toBe(2)
    await journal.appendStopEvent({ reason: 'user-stop' }, 0)
    journal.queuedMessages.nextInputCard()
    await journal.resolveDispatch({
      clientMessageId: 'sent-S',
      state: 'accepted',
      providerIdentity: null,
      fence: 0
    })
    expect(journal.inputOrder.lineage.cards.has('S')).toBe(false)
    expect(position()).toBe(2)
    await journal.appendQueueResume(0)
    journal.queuedMessages.nextInputCard()
    expect(position()).toBe(1)
  } finally {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  }
})
