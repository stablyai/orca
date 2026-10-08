// A /compact asked to wait (`delivery`) while the agent works: held as a card like a queued
// send, answered at once, run when the queue drains it. Without the opt-in, today's refusal.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { ConversationCommandParams } from '../../../shared/rpc-contract/structured-agent-session-params'
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
import {
  QUEUED_MESSAGES_PERSON_RESERVE_BYTES,
  QUEUED_MESSAGES_PUBLISHED_MAX_BYTES
} from './structured-agent-session-queued-published-bytes'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

function compact(
  delivery?: 'queue-if-active',
  clientOperationId = hostTestOperationId(),
  options?: { internal?: true }
) {
  const fields = { command: 'compact' as const, ...(delivery ? { delivery } : {}) }
  return {
    id: clientOperationId,
    result: rig.host.conversationCommand(CALLER, {
      envelope: rig.envelope(fields, 'agentSession.conversationCommand', clientOperationId),
      ...fields,
      ...(options?.internal ? {} : { userSend: true as const })
    })
  }
}

function clear() {
  const fields = { command: 'clear' as const }
  return rig.host.conversationCommand(CALLER, {
    envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId()),
    ...fields
  })
}

async function queuedCompact(): Promise<string> {
  const { id, result } = compact('queue-if-active')
  expect(await result).toMatchObject({
    ok: true,
    value: { command: 'compact', state: 'completed', queued: { messageId: id, state: 'waiting' } }
  })
  return id
}

function prompt(state: 'pending' | 'resolved') {
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  return journal.appendItem(
    { provider: 'orca', clientMessageId: 'prompt-1' },
    {
      kind: 'approval',
      title: 'Allow the tool?',
      detail: null,
      options: [],
      resolution:
        state === 'pending'
          ? { state, selectedOptionId: null, resolvedBy: null, resolvedAt: null }
          : { state, selectedOptionId: 'allow', resolvedBy: 'client-1', resolvedAt: 1 }
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
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

describe('a /compact that waits in line', () => {
  it("uses the person's reserve when background cards fill their bound", async () => {
    await rig.workingSend()
    const backgroundRoom =
      QUEUED_MESSAGES_PUBLISHED_MAX_BYTES - QUEUED_MESSAGES_PERSON_RESERVE_BYTES
    const overhead = Buffer.byteLength(JSON.stringify(hostTestMessage('')), 'utf8')
    const background = rig.send('x'.repeat(backgroundRoom - overhead), 'queue-if-active', {
      internal: true
    })
    expect(await background.result).toMatchObject({
      ok: true,
      value: { queued: { messageId: background.id, state: 'waiting' } }
    })
    expect(
      await compact('queue-if-active', hostTestOperationId(), { internal: true }).result
    ).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'queueTooLarge' } }
    })
    const compactId = await queuedCompact()
    expect(await rig.drafts()).toEqual([
      { messageId: background.id, state: 'waiting' },
      { messageId: compactId, state: 'waiting' }
    ])
    expect(rig.compact).not.toHaveBeenCalled()
  })

  it('behind an unanswered message: a card at once, run once that message is answered', async () => {
    const working = await rig.workingSend()
    const compactId = await queuedCompact()
    expect(await rig.drafts()).toEqual([{ messageId: compactId, state: 'waiting' }])
    await settleMs()
    expect(rig.compact).not.toHaveBeenCalled()
    await rig.settleAccepted(working, 'a')
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
    expect((await rig.handoff(compactId))?.handedOverAt).toBeDefined()
    expect(await rig.drafts()).toEqual([])
  })

  it('behind a running command turn: waits for that turn to end', async () => {
    expect(await compact().result).toMatchObject({ ok: true, value: { state: 'completed' } })
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
    const second = await queuedCompact()
    await settleMs()
    expect(rig.compact).toHaveBeenCalledOnce()
    rig.finishCompact()
    await eventually(() => expect(rig.compact).toHaveBeenCalledTimes(2))
    expect((await rig.handoff(second))?.handedOverAt).toBeDefined()
  })

  it('behind a pending question or approval: waits for its answer', async () => {
    await prompt('pending')
    const compactId = await queuedCompact()
    await settleMs()
    expect(rig.compact).not.toHaveBeenCalled()
    await prompt('resolved')
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
    expect(await rig.handoff(compactId)).toBeDefined()
  })

  it('behind a message the agent refuses: still runs, nothing strands', async () => {
    const working = await rig.workingSend()
    await queuedCompact()
    await rig.settleRejected(working, 'provider refused this payload')
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
  })

  it('a resent id answers from its card, then from the submission it became; one run', async () => {
    const working = await rig.workingSend()
    const compactId = await queuedCompact()
    expect(await compact('queue-if-active', compactId).result).toMatchObject({
      ok: true,
      value: { queued: { messageId: compactId, state: 'waiting' } }
    })
    expect(await rig.drafts()).toHaveLength(1)
    await rig.settleAccepted(working, 'a')
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
    const resent = await compact('queue-if-active', compactId).result
    expect(resent).toMatchObject({ ok: true, value: { command: 'compact', state: 'completed' } })
    expect(resent.ok && resent.value.queued).toBeFalsy()
    await settleMs()
    expect(rig.compact).toHaveBeenCalledOnce()
    expect(
      (await rig.host.journalSnapshot(SESSION)).submissions.filter(
        (entry) => entry.queuedMessageId === compactId
      )
    ).toHaveLength(1)
  })

  it('never steers: Send-now on its card mid-turn is refused and it keeps waiting', async () => {
    const working = await rig.workingSend()
    const compactId = await queuedCompact()
    expect(await rig.sendNow(compactId)).toMatchObject({
      ok: false,
      refusal: { message: "A command can't be sent while the agent is working." }
    })
    expect(await rig.handoff(compactId)).toBeUndefined()
    await rig.settleAccepted(working, 'a')
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
  })

  it('a later send waits behind it, in the order sent', async () => {
    const working = await rig.workingSend()
    const compactId = await queuedCompact()
    const later = await rig.send('sent after the compact', 'queue-if-active').result
    if (!later.ok || !('queued' in later.value)) {
      throw new Error('expected a queued receipt')
    }
    const laterId = later.value.queued.messageId
    await rig.settleAccepted(working, 'a')
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
    // The compaction's turn runs, so the later card still waits.
    await settleMs()
    expect(await rig.handoff(laterId)).toBeUndefined()
    rig.finishCompact()
    await eventually(async () => expect(await rig.handoff(laterId)).toBeDefined())
    expect(
      (await rig.host.journalSnapshot(SESSION)).submissions.flatMap((entry) =>
        entry.queuedMessageId ? [entry.queuedMessageId] : []
      )
    ).toEqual([compactId, laterId])
  })

  it('at rest, runs at once as before', async () => {
    const { result } = compact('queue-if-active')
    const answer = await result
    expect(answer).toMatchObject({ ok: true, value: { command: 'compact', state: 'completed' } })
    expect(answer.ok && answer.value.queued).toBeFalsy()
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
    expect(await rig.drafts()).toEqual([])
  })

  it('without the opt-in (an older client), is refused while a message is unanswered, as today', async () => {
    await rig.workingSend()
    expect(await compact().result).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'messagesUnsettled' } }
    })
    expect(await rig.drafts()).toEqual([])
  })

  it('Delete takes it back: it never runs', async () => {
    const working = await rig.workingSend()
    const compactId = await queuedCompact()
    expect(await rig.deleteQueued(compactId)).toMatchObject({ ok: true, value: { deleted: true } })
    await rig.settleAccepted(working, 'a')
    await settleMs()
    expect(rig.compact).not.toHaveBeenCalled()
    expect(await rig.drafts()).toEqual([])
  })

  it('Stop pauses it with the queue, and Resume runs it', async () => {
    const working = await rig.workingSend()
    const compactId = await queuedCompact()
    await rig.stop()
    await rig.settleAccepted(working, 'a')
    await settleMs()
    expect(rig.compact).not.toHaveBeenCalled()
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    expect(await rig.drafts()).toEqual([{ messageId: compactId, state: 'waiting' }])
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
  })

  /** The rows that report a failure, and the cards still listed. */
  async function failureRowsAndCards() {
    const snapshot = await rig.host.journalSnapshot(SESSION)
    return {
      failures: snapshot.items.filter(
        (item) => item.body.kind === 'status' && item.body.tone === 'error'
      ),
      cards: await rig.drafts()
    }
  }

  it('refused by the agent: spent, said once in its turn, and the next card still runs', async () => {
    // Every compaction is refused, as on a short chat: a returned card would loop or block.
    rig.compact.mockResolvedValue({
      state: 'rejected',
      ...agentSessionFailureWords(
        agentSessionFailureFact('providerRejected', {
          detail: { text: 'Not enough messages to compact.', audience: 'person' }
        }),
        { surface: 'rejection' }
      )
    })
    const working = await rig.workingSend()
    await queuedCompact()
    const later = await rig.send('sent after the compact', 'queue-if-active').result
    if (!later.ok || !('queued' in later.value)) {
      throw new Error('expected a queued receipt')
    }
    await rig.settleAccepted(working, 'a')
    const laterId = later.value.queued.messageId
    await eventually(async () => expect(await rig.handoff(laterId)).toBeDefined())
    const { failures, cards } = await failureRowsAndCards()
    expect(failures).toHaveLength(1)
    expect(JSON.stringify(failures[0]!.body)).toContain('Not enough messages to compact.')
    expect(cards).toEqual([])
    expect(rig.compact).toHaveBeenCalledOnce()
  })

  it('refused before it starts (background tasks): one row says so, and the next card runs', async () => {
    let tasks: AgentChildWorkView[] = []
    Object.assign(rig.host.deps, {
      statusSink: { publish: () => {}, forget: () => {}, readChildWork: () => tasks }
    })
    const working = await rig.workingSend()
    const compactId = await queuedCompact()
    const later = await rig.send('sent after the compact', 'queue-if-active').result
    if (!later.ok || !('queued' in later.value)) {
      throw new Error('expected a queued receipt')
    }
    tasks = [BACKGROUND_TASK]
    await rig.settleAccepted(working, 'a')
    const laterId = later.value.queued.messageId
    await eventually(async () => expect(await rig.handoff(laterId)).toBeDefined())
    expect(rig.compact).not.toHaveBeenCalled()
    // Refused while still queued: no hand-off was recorded for a command that never left.
    const refused = await rig.handoff(compactId)
    expect(refused).toMatchObject({ dispatchState: 'rejected' })
    expect(refused?.handedOverAt).toBeUndefined()
    const { failures, cards } = await failureRowsAndCards()
    expect(failures).toHaveLength(1)
    // The reason, as the direct path says it, not a bare "try it again".
    expect(failures[0]!.body).toMatchObject({
      text: 'Background tasks are still running. Wait for the background tasks to finish. Run /compact again.'
    })
    expect(cards).toEqual([])
  })

  it('refused before it starts, a failed rejection write never drops the card without its row', async () => {
    let tasks: AgentChildWorkView[] = []
    Object.assign(rig.host.deps, {
      statusSink: { publish: () => {}, forget: () => {}, readChildWork: () => tasks }
    })
    const working = await rig.workingSend()
    const compactId = await queuedCompact()
    const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
    const resolve = journal.resolveDispatch.bind(journal)
    const failed = vi.fn()
    vi.spyOn(journal, 'resolveDispatch').mockImplementation(async (input) => {
      if (input.state === 'rejected' && !failed.mock.calls.length) {
        failed()
        throw new Error('disk full')
      }
      return resolve(input)
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    tasks = [BACKGROUND_TASK]
    await rig.settleAccepted(working, 'a')
    await eventually(() => expect(failed).toHaveBeenCalledOnce())
    // The refusal's row landed before the write that failed, so the card never left without it;
    // the loop then reports its own fault, and nothing was ever handed over.
    const { failures } = await failureRowsAndCards()
    expect(failures.map((row) => row.body)).toContainEqual(
      expect.objectContaining({
        text: 'Background tasks are still running. Wait for the background tasks to finish. Run /compact again.'
      })
    )
    expect((await rig.handoff(compactId))?.handedOverAt).toBeUndefined()
    expect(rig.compact).not.toHaveBeenCalled()
  })

  it('a failed agent start returns its card like any card, never spends it', async () => {
    await rig.dispose()
    rig = await createQueuedMessageTestRig({ restartable: true })
    const working = await rig.workingSend()
    const compactId = await queuedCompact()
    await rig.stop()
    await rig.settleAccepted(working, 'a')
    // The chat's agent went away; the next start fails.
    await rig.restartHostProcess()
    rig.failNextStart(new Error('the agent could not start'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await rig.resume()).toMatchObject({ ok: true })
    await eventually(async () =>
      expect(await rig.drafts()).toEqual([{ messageId: compactId, state: 'returned' }])
    )
    expect(rig.compact).not.toHaveBeenCalled()
  })

  it('Send on its card works whenever the agent is idle, as after a paused queue', async () => {
    const working = await rig.workingSend()
    const compactId = await queuedCompact()
    await rig.stop()
    await rig.settleAccepted(working, 'a')
    expect(await rig.sendNow(compactId)).toMatchObject({
      ok: true,
      value: { submission: { queuedMessageId: compactId } }
    })
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
  })

  /** A command card consumed while the agent starts, and never handed over: then Orca crashes. */
  async function consumedThenCrashed(send: 'drain' | 'sendNow'): Promise<string> {
    await rig.dispose()
    rig = await createQueuedMessageTestRig({ restartable: true })
    const working = await rig.workingSend()
    const compactId = await queuedCompact()
    await rig.stop()
    await rig.settleAccepted(working, 'a')
    // No child now, and the next start stays in its spawn: the hand-off stays queued.
    await rig.host.close(SESSION, 'evict')
    const release = rig.holdNextStart()
    const startsBefore = rig.starts.mock.calls.length
    if (send === 'drain') {
      expect(await rig.resume()).toMatchObject({ ok: true })
    } else {
      expect(await rig.sendNow(compactId)).toMatchObject({ ok: true })
    }
    await eventually(() => expect(rig.starts.mock.calls.length).toBeGreaterThan(startsBefore))
    rig.crashRestartHostProcess()
    release()
    return compactId
  }

  it('cut short by a restart after the queue sent it: waits again under the restart, never spent', async () => {
    const compactId = await consumedThenCrashed('drain')
    // The queue's own hand-off is not the person's, so it waits as any queued card does after a
    // restart: held unshown, never sent by itself.
    await eventually(async () =>
      expect(await rig.drafts()).toEqual([{ messageId: compactId, state: 'waiting' }])
    )
    expect(await rig.queuePause()).toBeNull()
    expect(rig.compact).not.toHaveBeenCalled()
  })

  it('cut short by a restart after the person sent it: waits again, never spent', async () => {
    const compactId = await consumedThenCrashed('sendNow')
    expect(await rig.drafts()).toEqual([{ messageId: compactId, state: 'waiting' }])
    expect(await rig.queuePause()).toBeNull()
    const card = rig.host
      .collaboratorsForTests()
      .sessions.get(SESSION)
      ?.journal.queuedMessages.get(compactId)
    expect(card).toMatchObject({
      holdReason: null,
      body: { command: { name: 'compact' } }
    })
    expect(rig.compact).not.toHaveBeenCalled()
  })

  it('a kept message stays ahead of a waiting /compact after the next turn releases both', async () => {
    await rig.dispose()
    rig = await createQueuedMessageTestRig({ restartable: true })
    const working = await rig.workingSend()
    const compactId = await queuedCompact()
    await rig.stop()
    await rig.settleAccepted(working, 'a')
    await rig.host.close(SESSION, 'evict')
    const release = rig.holdNextStart()
    const startsBefore = rig.starts.mock.calls.length
    const kept = rig.send('kept message')
    await kept.result
    await eventually(() => expect(rig.starts.mock.calls.length).toBeGreaterThan(startsBefore))
    // Finish the old host before reopening so its delayed start cannot keep writing.
    const restarted = rig.quitRestartHostProcess()
    release()
    await restarted

    expect(await rig.drafts()).toEqual([
      { messageId: kept.id, state: 'waiting' },
      { messageId: compactId, state: 'waiting' }
    ])
    expect(rig.compact).not.toHaveBeenCalled()
    const next = rig.send('next turn', 'queue-if-active')
    expect(await next.result).toMatchObject({ ok: true, value: { submission: expect.anything() } })
    await eventually(async () =>
      expect((await rig.submission(next.id))?.handedOverAt).toBeDefined()
    )
    await rig.settleAccepted(next.id, 'next')
    await eventually(async () => expect((await rig.handoff(kept.id))?.handedOverAt).toBeDefined())
    expect(rig.dispatch.mock.calls.at(-1)?.[0].body.blocks).toEqual([
      { type: 'text', text: 'kept message' }
    ])
    expect(rig.compact).not.toHaveBeenCalled()
    await rig.settleAccepted(await rig.handoffId(kept.id), 'kept')
    await eventually(() => expect(rig.compact).toHaveBeenCalledOnce())
    expect(await rig.drafts()).toEqual([])
  })

  it('a direct /compact (no opt-in, as on a host without the queue) cut short by a restart is never a card', async () => {
    await rig.dispose()
    rig = await createQueuedMessageTestRig({ restartable: true })
    await rig.workingSend()
    await rig.host.close(SESSION, 'evict')
    const release = rig.holdNextStart()
    const startsBefore = rig.starts.mock.calls.length
    const { id } = compact()
    await eventually(() => expect(rig.starts.mock.calls.length).toBeGreaterThan(startsBefore))
    rig.crashRestartHostProcess()
    release()
    // A command in flight is not resumed: the person runs it again. No card, kept or otherwise.
    expect(await rig.drafts()).toEqual([])
    expect(await rig.submission(id)).toMatchObject({ dispatchState: 'rejected' })
  })

  it('a /clear drops a waiting command card instead of carrying it to the new chat', async () => {
    const working = await rig.workingSend()
    await queuedCompact()
    const draft = await rig.send('carried draft', 'queue-if-active').result
    if (!draft.ok || !('queued' in draft.value)) {
      throw new Error('expected a queued receipt')
    }
    await rig.stop()
    await rig.settleAccepted(working, 'a')
    const cleared = await clear()
    const replacementId = cleared.ok ? cleared.value.replacementSessionId : undefined
    if (!replacementId) {
      throw new Error('expected a replacement session')
    }
    expect(await rig.drafts()).toEqual([])
    expect(await rig.drafts(replacementId)).toEqual([
      { messageId: draft.value.queued.messageId, state: 'waiting' }
    ])
    expect(rig.compact).not.toHaveBeenCalled()
  })

  it('a /clear with only a command card waiting opens no replacement conversation for it', async () => {
    const working = await rig.workingSend()
    await queuedCompact()
    await rig.stop()
    await rig.settleAccepted(working, 'a')
    const cleared = await clear()
    const replacementId = cleared.ok ? cleared.value.replacementSessionId : undefined
    if (!replacementId) {
      throw new Error('expected a replacement session')
    }
    expect(await rig.drafts()).toEqual([])
    expect(rig.host.collaboratorsForTests().sessions.has(replacementId)).toBe(false)
  })
})

it('only a /compact may ask to wait; a /clear sent asking to is refused, never queued', async () => {
  const base = { envelope: rig.envelope({}, 'agentSession.conversationCommand', 'op-schema') }
  const parse = (fields: Record<string, unknown>) =>
    ConversationCommandParams.safeParse({ ...base, ...fields }).success
  expect(parse({ command: 'compact', delivery: 'queue-if-active' })).toBe(true)
  expect(parse({ command: 'compact', delivery: 'now' })).toBe(false)
  await rig.workingSend()
  const fields = { command: 'clear' as const, delivery: 'queue-if-active' as const }
  expect(
    await rig.host.conversationCommand(CALLER, {
      envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId()),
      ...fields
    })
  ).toMatchObject({ ok: false })
  expect(await rig.drafts()).toEqual([])
})
