// A /clear asked to wait (`delivery`) while the agent works: held as a card like a queued send,
// answered at once, and run by the host itself when its turn comes, in the same conversation. The
// cards sent after it run in the fresh context, in order. Without the opt-in, today's refusal.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionBackgroundTaskStops } from '../../../shared/agent-child-work-stop-targets'
import { agentSessionOperationKey } from '../../../shared/agent-session-operation-ledger'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { QUEUED_CLEAR_CALLER_KEY } from './structured-conversation-clear'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

function clear(delivery?: 'queue-if-active', clientOperationId = hostTestOperationId()) {
  const fields = { command: 'clear' as const, ...(delivery ? { delivery } : {}) }
  return rig.host.conversationCommand(CALLER, {
    envelope: rig.envelope(fields, 'agentSession.conversationCommand', clientOperationId),
    ...fields,
    userSend: true
  })
}

async function queuedClear(): Promise<string> {
  const id = hostTestOperationId()
  expect(await clear('queue-if-active', id)).toMatchObject({
    ok: true,
    value: { command: 'clear', state: 'completed', queued: { messageId: id, state: 'waiting' } }
  })
  return id
}

async function queuedSend(text: string): Promise<string> {
  const sent = await rig.send(text, 'queue-if-active').result
  if (!sent.ok || !('queued' in sent.value)) {
    throw new Error('expected a queued receipt')
  }
  return sent.value.queued.messageId
}

function journal() {
  return rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
}

async function dividers(): Promise<number> {
  return (await rig.host.journalSnapshot(SESSION)).items.filter(
    (item) => item.body.kind === 'status' && item.body.presentation === 'context-cleared'
  ).length
}

const BACKGROUND_TASK: AgentChildWorkView = {
  id: 'child-dev',
  providerId: 'task-dev',
  kind: 'command',
  description: 'npm run dev',
  state: 'working',
  membership: 'live',
  firstObservedAt: 1,
  observedAt: 1,
  stoppable: true,
  invocation: { invocationId: 'spawn-dev', generation: 1 }
}

const settleMs = () => new Promise((resolve) => setTimeout(resolve, 150))

describe('a /clear that waits in line', () => {
  it('behind an unanswered message: a card at once, nothing stopped or cleared yet', async () => {
    await rig.workingSend()
    const clearId = await queuedClear()
    expect(await rig.drafts()).toEqual([{ messageId: clearId, state: 'waiting' }])
    expect(journal().queuedMessages.get(clearId)?.body).toMatchObject({
      blocks: [{ type: 'text', text: '/clear' }],
      command: { name: 'clear' }
    })
    await settleMs()
    expect(rig.closeSession).not.toHaveBeenCalled()
    expect(rig.store.getRecord(SESSION)?.providerContextBoundary).toBeUndefined()
    expect(await dividers()).toBe(0)
  })

  it('runs in the same chat once the turn ends: one divider, spent in that write, never sent', async () => {
    const working = await rig.workingSend()
    const clearId = await queuedClear()
    await rig.settleAccepted(working, 'a')
    await eventually(async () => expect(await dividers()).toBe(1))
    expect(rig.closeSession).toHaveBeenCalled()
    expect(rig.store.getRecord(SESSION)).toMatchObject({
      providerHandleChain: [],
      conversationCommand: {
        command: 'clear',
        operationId: clearId,
        callerKey: QUEUED_CLEAR_CALLER_KEY,
        phase: 'committed'
      }
    })
    expect(journal().queuedMessages.get(clearId)).toMatchObject({
      state: 'withdrawn',
      settledByOp: agentSessionOperationKey(QUEUED_CLEAR_CALLER_KEY, clearId)
    })
    expect(await rig.drafts()).toEqual([])
    expect(await rig.handoff(clearId)).toBeUndefined()
    expect(rig.dispatch).toHaveBeenCalledOnce()
  })

  it('cards sent after it run in the fresh context, in order, unpaused', async () => {
    const working = await rig.workingSend()
    const clearId = await queuedClear()
    const first = await queuedSend('first after the clear')
    const second = await queuedSend('second after the clear')
    await rig.settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
    expect(await dividers()).toBe(1)
    expect(await rig.queuePause()).toBeNull()
    expect(journal().queuedMessages.pauses()).toEqual([])
    // The first is the agent's work now, so the second waits for it.
    await settleMs()
    expect(await rig.handoff(second)).toBeUndefined()
    expect(await rig.drafts()).toEqual([{ messageId: second, state: 'waiting' }])
    const sent = (await rig.host.journalSnapshot(SESSION)).submissions
    expect(sent.flatMap((entry) => (entry.queuedMessageId ? [entry.queuedMessageId] : []))).toEqual(
      [first]
    )
    expect(sent.some((entry) => entry.queuedMessageId === clearId)).toBe(false)
  })

  it('a resent id answers from its card, and after it ran as withdrawn; one clear', async () => {
    const working = await rig.workingSend()
    const clearId = await queuedClear()
    expect(await clear('queue-if-active', clearId)).toMatchObject({
      ok: true,
      value: { queued: { messageId: clearId, state: 'waiting' } }
    })
    await rig.settleAccepted(working, 'a')
    await eventually(async () => expect(await dividers()).toBe(1))
    expect(await clear('queue-if-active', clearId)).toMatchObject({
      ok: true,
      value: { command: 'clear', queued: { messageId: clearId, state: 'withdrawn' } }
    })
    await settleMs()
    expect(await dividers()).toBe(1)
  })

  it('a restart after it ran never runs it again', async () => {
    const working = await rig.workingSend()
    await queuedClear()
    const after = await queuedSend('after the clear')
    await rig.settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(after)).toBeDefined())
    await rig.quitRestartHostProcess()
    await rig.host.journalSnapshot(SESSION)
    await settleMs()
    expect(await dividers()).toBe(1)
  })

  it('never steers: its Send mid-turn is refused and it keeps waiting', async () => {
    const working = await rig.workingSend()
    const clearId = await queuedClear()
    expect(await rig.sendNow(clearId)).toMatchObject({
      ok: false,
      refusal: { message: "A command can't be sent while the agent is working." }
    })
    expect(await dividers()).toBe(0)
    await rig.settleAccepted(working, 'a')
    await eventually(async () => expect(await dividers()).toBe(1))
  })

  it('Delete takes it back: it never runs, and the cards behind it send as usual', async () => {
    const working = await rig.workingSend()
    const clearId = await queuedClear()
    const after = await queuedSend('after')
    expect(await rig.deleteQueued(clearId)).toMatchObject({ ok: true, value: { deleted: true } })
    await rig.settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(after)).toBeDefined())
    expect(await dividers()).toBe(0)
  })

  it('at rest, clears at once as before', async () => {
    const answer = await clear('queue-if-active')
    expect(answer).toMatchObject({ ok: true, value: { command: 'clear', state: 'completed' } })
    expect(answer.ok && answer.value.queued).toBeFalsy()
    expect(await dividers()).toBe(1)
    expect(await rig.drafts()).toEqual([])
  })

  it('without the opt-in (an older client), is refused while a message is unanswered, as today', async () => {
    await rig.workingSend()
    expect(await clear()).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'messagesUnsettled' } }
    })
    expect(await rig.drafts()).toEqual([])
  })
})

/** The provider's background Stop: Claude's strip offers one; Codex's and ACP's offer none. */
const STOPS_ALL: AgentSessionBackgroundTaskStops = { supportsTaskStop: true, supportsStopAll: true }
const NO_STOP: AgentSessionBackgroundTaskStops = { supportsTaskStop: false, supportsStopAll: false }

function withStops(stops: AgentSessionBackgroundTaskStops): void {
  Object.assign(rig.host.deps.adapter, { backgroundTaskStops: () => stops })
}

/** A turn that ended leaving background tasks running, the agent idle. */
async function withBackgroundTasks(
  stops = STOPS_ALL
): Promise<{ set: (next: AgentChildWorkView[]) => void }> {
  let tasks: AgentChildWorkView[] = []
  withStops(stops)
  Object.assign(rig.host.deps, {
    statusSink: { publish: () => {}, forget: () => {}, readChildWork: () => tasks }
  })
  const working = await rig.workingSend()
  tasks = [BACKGROUND_TASK]
  await rig.settleAccepted(working, 'a')
  return { set: (next) => (tasks = next) }
}

const SETTLED_TASK: AgentChildWorkView = {
  ...BACKGROUND_TASK,
  state: 'done',
  membership: 'settled',
  outcome: 'succeeded'
}

/** A Stop the provider acknowledged ahead of the task's own ending, which it then delivers. */
function stoppedTaskEnding() {
  let owed = false
  Object.assign(rig.host.deps.adapter, { stoppedTaskEndingOwed: () => owed })
  return {
    acknowledge(tasks: { set: (next: AgentChildWorkView[]) => void }) {
      owed = true
      tasks.set([{ ...BACKGROUND_TASK, state: 'done', membership: 'settled', outcome: 'cancelled' }])
    },
    endingLands() {
      owed = false
    }
  }
}

describe('a /clear card the queue cannot run yet', () => {
  it('typed while idle with background tasks running, waits as a card too, then runs', async () => {
    const tasks = await withBackgroundTasks()
    const clearId = await queuedClear()
    expect(await dividers()).toBe(0)
    const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.nextQueuedMessageWait).toEqual({
      messageId: clearId,
      reason: 'background-tasks'
    })
    // A message sent now joins the queue behind it, for the cleared chat.
    const after = await queuedSend('after the clear')
    tasks.set([SETTLED_TASK])
    rig.host.publishChildWorkEvidence(SESSION, [])
    await eventually(async () => expect(await rig.handoff(after)).toBeDefined())
    expect(await dividers()).toBe(1)
  })

  it('child-work updates while it waits run no drain step', async () => {
    let tasks: AgentChildWorkView[] = []
    withStops(STOPS_ALL)
    Object.assign(rig.host.deps, {
      statusSink: { publish: () => {}, forget: () => {}, readChildWork: () => tasks }
    })
    const working = await rig.workingSend()
    await queuedClear()
    tasks = [BACKGROUND_TASK]
    await rig.settleAccepted(working, 'a')
    await settleMs()
    const snapshot = vi.spyOn(journal(), 'snapshot')
    for (let tick = 0; tick < 5; tick += 1) {
      rig.host.publishChildWorkEvidence(SESSION, [])
    }
    await settleMs()
    expect(snapshot).not.toHaveBeenCalled()
    expect(await dividers()).toBe(0)
  })

  it('held by a reopen, publishes no next card and no wait, and its Send runs it', async () => {
    await rig.workingSend()
    const clearId = await queuedClear()
    await rig.quitRestartHostProcess()
    const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.nextQueuedMessageId).toBeNull()
    expect(page.ok && page.page.nextQueuedMessageWait).toBeNull()
    expect(await rig.drafts()).toEqual([{ messageId: clearId, state: 'waiting' }])
    expect(await rig.sendNow(clearId)).toMatchObject({
      ok: true,
      value: { queued: { messageId: clearId, state: 'withdrawn' } }
    })
    expect(await dividers()).toBe(1)
  })

  it('waits out background tasks, then runs when they end; the cards behind it wait too', async () => {
    let tasks: AgentChildWorkView[] = []
    withStops(STOPS_ALL)
    Object.assign(rig.host.deps, {
      statusSink: { publish: () => {}, forget: () => {}, readChildWork: () => tasks }
    })
    const working = await rig.workingSend()
    const clearId = await queuedClear()
    const after = await queuedSend('after the clear')
    tasks = [BACKGROUND_TASK]
    await rig.settleAccepted(working, 'a')
    await settleMs()
    expect(await rig.drafts()).toEqual([
      { messageId: clearId, state: 'waiting' },
      { messageId: after, state: 'waiting' }
    ])
    expect(await dividers()).toBe(0)
    // Not named as the queue's next send while it waits, so no client reads the chat as busy; the
    // wait is published instead, so clients read it rather than guess.
    const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.nextQueuedMessageId).toBeNull()
    expect(page.ok && page.page.nextQueuedMessageWait).toEqual({
      messageId: clearId,
      reason: 'background-tasks'
    })
    // Its Send says why it waits, and changes nothing on the card.
    expect(await rig.sendNow(clearId)).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'backgroundTasksRunning' } }
    })
    tasks = [{ ...BACKGROUND_TASK, state: 'done', membership: 'settled', outcome: 'succeeded' }]
    rig.host.publishChildWorkEvidence(SESSION, [])
    await eventually(async () => expect(await rig.handoff(after)).toBeDefined())
    expect(await dividers()).toBe(1)
  })

  it("after the strip's Stop, waits for the stopped task's own ending, not the acknowledgement", async () => {
    const tasks = await withBackgroundTasks()
    const stopped = stoppedTaskEnding()
    const clearId = await queuedClear()
    // Claude answers the Stop before the task's own "stopped" lands; the record already reads settled.
    stopped.acknowledge(tasks)
    rig.host.publishChildWorkEvidence(SESSION, [])
    await settleMs()
    expect(await dividers()).toBe(0)
    expect(rig.closeSession).not.toHaveBeenCalled()
    const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.nextQueuedMessageWait).toEqual({
      messageId: clearId,
      reason: 'background-tasks'
    })
    stopped.endingLands()
    rig.host.publishChildWorkEvidence(SESSION, [])
    await eventually(async () => expect(await dividers()).toBe(1))
  })

  it('after the stopped task ends, waits out the turn the agent answers it in', async () => {
    const tasks = await withBackgroundTasks()
    const stopped = stoppedTaskEnding()
    await queuedClear()
    stopped.acknowledge(tasks)
    rig.host.publishChildWorkEvidence(SESSION, [])
    await settleMs()
    // The task's own ending opens the agent's turn answering it.
    stopped.endingLands()
    await openRigTurnFor(rig, 'task-ended')
    rig.host.publishChildWorkEvidence(SESSION, [])
    await settleMs()
    expect(await dividers()).toBe(0)
    expect(rig.closeSession).not.toHaveBeenCalled()
    await openRigTurnFor(rig, 'task-ended', 'completed')
    await eventually(async () => expect(await dividers()).toBe(1))
    const turns = (await rig.host.journalSnapshot(SESSION)).items.flatMap((item) =>
      item.body.kind === 'turn' && item.body.turnId === 'turn-of-task-ended' ? [item.body.state] : []
    )
    expect(turns).toEqual(['completed'])
  })

  it('a failed commit returns it with why once; nothing behind it runs; Send retries', async () => {
    const working = await rig.workingSend()
    const clearId = await queuedClear()
    const after = await queuedSend('after the clear')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(rig.store.conversationReceipts, 'queuedClear').mockReturnValueOnce({
      write: () => {
        throw new Error('disk full')
      },
      committed: () => {}
    })
    await rig.settleAccepted(working, 'a')
    await eventually(async () =>
      expect(await rig.drafts()).toEqual([
        { messageId: clearId, state: 'returned' },
        { messageId: after, state: 'waiting' }
      ])
    )
    // Rolled back whole: no divider, no fresh context, and the card was not spent.
    expect(await dividers()).toBe(0)
    expect(rig.store.getRecord(SESSION)?.providerContextBoundary).toBeUndefined()
    expect(journal().queuedMessages.get(clearId)).toMatchObject({
      state: 'returned',
      returnedRejection: { kind: 'commandRefused' }
    })
    await settleMs()
    expect(await rig.handoff(after)).toBeUndefined()

    expect(await rig.sendNow(clearId)).toMatchObject({
      ok: true,
      value: { queued: { messageId: clearId, state: 'withdrawn' } }
    })
    expect(await dividers()).toBe(1)
    await eventually(async () => expect(await rig.handoff(after)).toBeDefined())
  })

  it('a returned /clear deleted: the cards behind it run in the uncleared chat', async () => {
    const working = await rig.workingSend()
    const clearId = await queuedClear()
    const after = await queuedSend('after the clear')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(rig.store.conversationReceipts, 'queuedClear').mockReturnValueOnce({
      write: () => {
        throw new Error('disk full')
      },
      committed: () => {}
    })
    await rig.settleAccepted(working, 'a')
    await eventually(async () =>
      expect(journal().queuedMessages.get(clearId)?.state).toBe('returned')
    )
    expect(await rig.deleteQueued(clearId)).toMatchObject({ ok: true, value: { deleted: true } })
    await eventually(async () => expect(await rig.handoff(after)).toBeDefined())
    expect(await dividers()).toBe(0)
  })

  it('its Send over a paused queue holds the cards queued before it; Resume sends them', async () => {
    const working = await rig.workingSend()
    const before = await queuedSend('before the clear')
    const clearId = await queuedClear()
    await rig.stop()
    const after = await queuedSend('after the clear')
    await rig.settleAccepted(working, 'a')
    expect(await rig.sendNow(clearId)).toMatchObject({ ok: true })
    expect(await dividers()).toBe(1)
    expect(journal().queuedMessages.pauses()).toContainEqual(
      expect.objectContaining({ reason: 'cleared', messageIds: [before] })
    )
    // The queue never reorders: the card after it waits behind the one it holds.
    await settleMs()
    expect(await rig.handoff(before)).toBeUndefined()
    expect(await rig.handoff(after)).toBeUndefined()
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect(await rig.handoff(before)).toBeDefined())
  })
})

describe('a /clear blocked by background tasks nothing here can stop', () => {
  it('typed while idle, is refused at once as before, and the next message goes straight out', async () => {
    await withBackgroundTasks(NO_STOP)
    expect(await clear('queue-if-active')).toMatchObject({
      ok: false,
      refusal: {
        details: { reason: 'backgroundTasksRunning' },
        message: 'Wait for background tasks to finish before using this command.'
      }
    })
    expect(await rig.drafts()).toEqual([])
    const next = await rig.send('stop the dev server', 'queue-if-active').result
    expect(next.ok && 'queued' in next.value).toBe(false)
    expect(await dividers()).toBe(0)
  })

  it('a live task the strip has no Stop for refuses it too, though the provider can stop others', async () => {
    await withBackgroundTasks(STOPS_ALL)
    Object.assign(rig.host.deps, {
      statusSink: {
        publish: () => {},
        forget: () => {},
        readChildWork: () => [{ ...BACKGROUND_TASK, stoppable: false }]
      }
    })
    Object.assign(rig.host.deps.adapter, {
      backgroundTaskStops: () => ({ supportsTaskStop: true, supportsStopAll: false })
    })
    expect(await clear('queue-if-active')).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'backgroundTasksRunning' } }
    })
    expect(await rig.drafts()).toEqual([])
  })

  it('sent mid-turn, is returned once with why when it reaches the front; nothing waits on it', async () => {
    let tasks: AgentChildWorkView[] = []
    withStops(NO_STOP)
    Object.assign(rig.host.deps, {
      statusSink: { publish: () => {}, forget: () => {}, readChildWork: () => tasks }
    })
    const working = await rig.workingSend()
    const clearId = await queuedClear()
    tasks = [BACKGROUND_TASK]
    await rig.settleAccepted(working, 'a')
    await eventually(async () =>
      expect(await rig.drafts()).toEqual([{ messageId: clearId, state: 'returned' }])
    )
    expect(journal().queuedMessages.get(clearId)).toMatchObject({
      returnedReason:
        'Background tasks are still running. Wait for the background tasks to finish. Run /clear again.',
      returnedRejection: {
        kind: 'commandRefused',
        refusal: { details: { reason: 'backgroundTasksRunning' } }
      }
    })
    const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.nextQueuedMessageWait).toBeNull()
    // Returned once: child-work ticks don't return it again or run it.
    const reason = journal().queuedMessages.get(clearId)?.returnedReason
    rig.host.publishChildWorkEvidence(SESSION, [])
    await settleMs()
    expect(journal().queuedMessages.get(clearId)?.returnedReason).toBe(reason)
    // A message typed now isn't held behind it.
    const next = rig.send('stop the dev server', 'queue-if-active')
    const sent = await next.result
    expect(sent.ok && 'queued' in sent.value).toBe(false)
    await eventually(async () => {
      const submissions = (await rig.host.journalSnapshot(SESSION)).submissions
      expect(
        submissions.find((entry) => entry.clientMessageId === next.id)?.handedOverAt
      ).toBeDefined()
    })
    expect(await dividers()).toBe(0)
    // Its Send runs it once the work has ended.
    tasks = [SETTLED_TASK]
    await rig.settleAccepted(next.id, 'b')
    expect(await rig.sendNow(clearId)).toMatchObject({
      ok: true,
      value: { queued: { messageId: clearId, state: 'withdrawn' } }
    })
    expect(await dividers()).toBe(1)
  })
})
