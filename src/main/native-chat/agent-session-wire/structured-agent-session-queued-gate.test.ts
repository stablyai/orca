// The one queue gate: admission, the drain step and Send-now consume a single
// typed hold decision, so the lists cannot drift — pinned here with a clear in
// doubt, Send-now's override set, and the replay-preference rule for a refused
// draft.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { structuredQueueHold } from './structured-agent-session-queued-messages'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig
let host: QueuedMessageTestRig['host']
let store: QueuedMessageTestRig['store']

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
  ;({ host, store } = rig)
})

afterEach(() => rig.dispose())

const envelope: QueuedMessageTestRig['envelope'] = (...args) => rig.envelope(...args)
const send: QueuedMessageTestRig['send'] = (...args) => rig.send(...args)
const sendNow: QueuedMessageTestRig['sendNow'] = (...args) => rig.sendNow(...args)
const submission: QueuedMessageTestRig['submission'] = (...args) => rig.submission(...args)
const drafts: QueuedMessageTestRig['drafts'] = () => rig.drafts()
const workingSend: QueuedMessageTestRig['workingSend'] = () => rig.workingSend()
const settleAccepted: QueuedMessageTestRig['settleAccepted'] = (...args) =>
  rig.settleAccepted(...args)
const settleRejected: QueuedMessageTestRig['settleRejected'] = (...args) =>
  rig.settleRejected(...args)

describe('the one queue gate', () => {
  it('a clear an older build left prepared holds nothing: Send-now sends the draft', async () => {
    await workingSend()
    const queued = await send('queued behind the clear', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    // An unfinished /clear changed nothing the chat reads, so it refuses no send.
    await store.setConversationCommand(SESSION, 1, {
      command: 'clear',
      runtimeFence: 1,
      operationId: hostTestOperationId(),
      callerKey: CALLER.callerKey,
      phase: 'prepared',
      state: 'unknown'
    })
    expect(await sendNow(draftId)).toMatchObject({ ok: true })
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
  })

  it('Send-now refuses on a pending prompt and overrides a running turn', async () => {
    const working = await workingSend()
    const queued = await send('queued mid-turn', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'prompt-1' },
      {
        kind: 'approval',
        title: 'Allow the tool?',
        detail: null,
        options: [],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    expect(await sendNow(draftId)).toMatchObject({
      ok: false,
      refusal: { message: expect.stringContaining('pending request') }
    })
    // Read in place: the gate runs on every admission and drain step.
    const snapshot = vi.spyOn(journal, 'snapshot')
    expect(structuredQueueHold({ journal, record: store.getRecord(SESSION), fence: 1 })).toBe(
      'prompt'
    )
    expect(snapshot).not.toHaveBeenCalled()
    snapshot.mockRestore()
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'prompt-1' },
      {
        kind: 'approval',
        title: 'Allow the tool?',
        detail: null,
        options: [],
        resolution: {
          state: 'resolved',
          selectedOptionId: 'allow',
          resolvedBy: 'client-1',
          resolvedAt: 1
        }
      },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    // The turn still runs (`working`), which Send-now alone may override.
    expect(await submission(working)).toMatchObject({ dispatchState: 'pending' })
    expect(await sendNow(draftId)).toMatchObject({
      ok: true,
      value: { submission: expect.anything() }
    })
  })
})

describe('replay preference', () => {
  it('a replayed send whose draft was refused answers with the returned card, never the rejected submission', async () => {
    const working = await workingSend()
    const body = hostTestMessage('refused later')
    const clientOperationId = hostTestOperationId()
    const params = {
      envelope: envelope(
        { body, delivery: 'queue-if-active' },
        'agentSession.send',
        clientOperationId
      ),
      body,
      delivery: 'queue-if-active' as const
    }
    expect(await host.send(CALLER, params)).toMatchObject({
      ok: true,
      value: { queued: { state: 'waiting' } }
    })
    await settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(clientOperationId)).toBeDefined())
    await settleRejected(await rig.handoffId(clientOperationId), 'provider refused this payload')
    await eventually(async () =>
      expect(await drafts()).toMatchObject([{ messageId: clientOperationId, state: 'returned' }])
    )
    // The original reply was lost; the retry must agree with the card, or the
    // same text renders twice — once on a Retry row, once on the card.
    const replay = await host.send(CALLER, params)
    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      value: { queued: { messageId: clientOperationId, state: 'returned' } }
    })
    if (replay.ok && 'submission' in replay.value) {
      throw new Error('replay answered with the rejected submission')
    }
  })
})

describe('replay of a deleted card', () => {
  it('answers withdrawn once its row is pruned, never with the rejected hand-off it came back from', async () => {
    const working = await workingSend()
    const body = hostTestMessage('refused, then deleted')
    const clientOperationId = hostTestOperationId()
    const params = {
      envelope: envelope(
        { body, delivery: 'queue-if-active' },
        'agentSession.send',
        clientOperationId
      ),
      body,
      delivery: 'queue-if-active' as const
    }
    await host.send(CALLER, params)
    await settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(clientOperationId)).toBeDefined())
    await settleRejected(await rig.handoffId(clientOperationId), 'provider refused this payload')
    await eventually(async () =>
      expect(await drafts()).toMatchObject([{ messageId: clientOperationId, state: 'returned' }])
    )
    expect(await rig.deleteQueued(clientOperationId)).toMatchObject({
      ok: true,
      value: { deleted: true }
    })
    // Retention later drops the tombstone; the rejected hand-off still names the draft.
    const journal = host.collaboratorsForTests().sessions.get(SESSION)?.journal
    if (!journal) {
      throw new Error('expected the conversation open')
    }
    vi.spyOn(journal.queuedMessages, 'get').mockReturnValue(null)
    const replay = await host.send(CALLER, params)
    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      value: { queued: { messageId: clientOperationId, state: 'withdrawn' } }
    })
    if (replay.ok && 'submission' in replay.value) {
      throw new Error('replay answered with the rejected hand-off')
    }
  })
})

describe('the hand-off link on answers', () => {
  it('a replayed queued send, once drained, answers with the hand-off that names its draft', async () => {
    const working = await workingSend()
    const body = hostTestMessage('drained later')
    const clientOperationId = hostTestOperationId()
    const params = {
      envelope: envelope(
        { body, delivery: 'queue-if-active' },
        'agentSession.send',
        clientOperationId
      ),
      body,
      delivery: 'queue-if-active' as const
    }
    await host.send(CALLER, params)
    await settleAccepted(working, 'a')
    await eventually(async () =>
      expect((await rig.handoff(clientOperationId))?.queuedMessageId).toBe(clientOperationId)
    )
    const replayed = await host.send(CALLER, params)
    expect(replayed).toMatchObject({
      ok: true,
      replayed: true,
      value: { submission: { queuedMessageId: clientOperationId } }
    })
    // Handed off under a fresh id, never the draft's (the send operation's) own.
    expect(
      replayed.ok && 'submission' in replayed.value && replayed.value.submission.clientMessageId
    ).not.toBe(clientOperationId)
    // The first send, direct, names no draft.
    expect(await submission(working)).not.toHaveProperty('queuedMessageId')
  })

  it('a queued send asked again after its ledger row is gone answers with its hand-off, never sending twice', async () => {
    const working = await workingSend()
    const body = hostTestMessage('asked again')
    const clientOperationId = hostTestOperationId()
    const params = {
      envelope: envelope(
        { body, delivery: 'queue-if-active' },
        'agentSession.send',
        clientOperationId
      ),
      body,
      delivery: 'queue-if-active' as const
    }
    await host.send(CALLER, params)
    await settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(clientOperationId)).toBeDefined())
    const handedOffAs = await rig.handoffId(clientOperationId)
    // The ledger forgot the id, so the send runs again rather than replaying.
    const operations = store['transactions'].state.operations
    for (const [key, row] of operations) {
      if (row.operationId === clientOperationId) {
        operations.delete(key)
      }
    }
    const count = (await host.journalSnapshot(SESSION)).submissions.length
    expect(await host.send(CALLER, params)).toMatchObject({
      ok: true,
      replayed: false,
      value: { submission: { clientMessageId: handedOffAs, queuedMessageId: clientOperationId } }
    })
    expect((await host.journalSnapshot(SESSION)).submissions).toHaveLength(count)
  })
})

describe('Send-now rerun', () => {
  it('a Send whose answer never settled answers again with the submission it made, never re-sending it', async () => {
    const working = await workingSend()
    const queued = await send('refused twice', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    await settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(draftId)).toBeDefined())
    await settleRejected(await rig.handoffId(draftId), 'first refusal')
    await eventually(async () =>
      expect(await drafts()).toMatchObject([{ messageId: draftId, state: 'returned' }])
    )
    const operationId = hostTestOperationId()
    expect(await sendNow(draftId, operationId)).toMatchObject({ ok: true })
    await settleRejected(operationId, 'second refusal')
    await eventually(async () =>
      expect(await drafts()).toMatchObject([{ messageId: draftId, state: 'returned' }])
    )
    // The host died before the Send's answer settled: its ledger row is still pending, so it reruns.
    const operations = store['transactions'].state.operations
    for (const [key, row] of operations) {
      if (row.operationId === operationId) {
        operations.set(key, { ...row, outcome: { status: 'pending' } })
      }
    }
    const count = (await host.journalSnapshot(SESSION)).submissions.length
    expect(await sendNow(draftId, operationId)).toMatchObject({
      ok: true,
      value: { clientMessageId: operationId, submission: { dispatchState: 'rejected' } }
    })
    expect((await host.journalSnapshot(SESSION)).submissions).toHaveLength(count)
    expect(await drafts()).toMatchObject([{ messageId: draftId, state: 'returned' }])
  })
})
