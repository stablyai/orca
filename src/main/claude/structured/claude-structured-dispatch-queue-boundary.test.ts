import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { AgentSessionPreDispatchError } from '../../native-chat/agent-session-wire/structured-agent-session-operation-settlement'
import { AgentSessionOptionRejectedError } from '../../native-chat/agent-session-wire/structured-agent-session-option-error'
import { createClaudeUserMessageQueue } from '../claude-agent-sdk-user-message-queue'
import { claudeTurnLifecycleIdentity } from '../claude-turn-lifecycle-item'
import { resolveClaudeReplayTurn } from '../claude-replay-turn-resolution'
import { dispatchClaudeTurn, rejectClaudeDispatchWaiters } from './claude-structured-dispatch'
import { createClaudeJournalTranslator } from './journal/claude-structured-journal-translation'
import { sessionFor } from './claude-structured-dispatch-test-support'
import { USER_MESSAGE } from './claude-structured-session-test-support'

it('refuses stale continuation work after waiting for the SDK input pump', async () => {
  const queue = createClaudeUserMessageQueue()
  const queued = Promise.withResolvers<void>()
  const send = vi.fn((_message, beforeDispatch?: () => Promise<void>) => {
    const result = queue.push(
      {
        type: 'user',
        session_id: 'provider-session',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'continue' }
      },
      beforeDispatch
    )
    queued.resolve()
    return result
  })
  const session = sessionFor(send)
  session.connection.send = send
  let superseded = false
  const refusal = new AgentSessionPreDispatchError('agent_session_restart_work_superseded')
  const beforeDispatch = vi.fn(async () => {
    if (superseded) {
      throw refusal
    }
  })
  const result = dispatchClaudeTurn(session, { body: USER_MESSAGE }, beforeDispatch).catch(
    (error: unknown) => error
  )
  await queued.promise
  expect(beforeDispatch).not.toHaveBeenCalled()
  expect(session.dispatchWaiters).toEqual([])
  superseded = true
  queue.end()
  const pump = queue.messages[Symbol.asyncIterator]()
  const handedOff = await pump.next()
  await pump.return?.()
  expect(handedOff.done).toBe(true)
  expect(await result).toBe(refusal)
  expect(beforeDispatch).toHaveBeenCalledOnce()
  expect(session.dispatchWaiters).toEqual([])
  expect(session.retiredDispatchWaiters).toEqual([])
})

it.each(['exit', 'capacity'] as const)(
  'refuses %s during authorization without leaked correlation',
  async (failure) => {
    const queue = createClaudeUserMessageQueue()
    const authorizing = Promise.withResolvers<void>()
    const authorized = Promise.withResolvers<void>()
    const queued = Promise.withResolvers<void>()
    const session = sessionFor()
    session.connection.send = (_message, beforeDispatch) => {
      const result = queue.push(
        {
          type: 'user',
          session_id: 'provider-session',
          parent_tool_use_id: null,
          message: { role: 'user', content: 'continue' }
        },
        beforeDispatch
      )
      queued.resolve()
      return result
    }
    const beforeDispatch = vi.fn(() => {
      authorizing.resolve()
      return authorized.promise
    })
    const result = dispatchClaudeTurn(session, { body: USER_MESSAGE }, beforeDispatch)
    await queued.promise
    const pump = queue.messages[Symbol.asyncIterator]()
    const handedOff = pump.next()
    await authorizing.promise
    if (failure === 'exit') {
      queue.fail(new Error('provider exited'))
    } else {
      session.connection.send = vi.fn().mockResolvedValue(undefined)
      for (let index = 0; index < 64; index += 1) {
        await dispatchClaudeTurn(session, {
          body: USER_MESSAGE,
          clientMessageId: `ordinary-${index}`
        })
      }
      queue.end()
    }
    authorized.resolve()
    expect((await handedOff).done).toBe(true)
    expect(await result).toMatchObject({ state: 'rejected' })
    expect(beforeDispatch).toHaveBeenCalledOnce()
    expect(session.dispatchWaiters).toHaveLength(failure === 'exit' ? 0 : 64)
    expect(session.retiredDispatchWaiters).toEqual([])
  }
)

function isSdkUserMessage(
  message: Record<string, unknown>
): message is Record<string, unknown> & SDKUserMessage {
  return message.type === 'user'
}

function handoffRig() {
  const queue = createClaudeUserMessageQueue()
  const session = sessionFor()
  const rows = new Map<string, AgentJournalItemBody | 'tombstone'>()
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => rows.set(agentJournalItemKey(identity), body),
    appendTombstone: (identity) => rows.set(agentJournalItemKey(identity), 'tombstone'),
    publish: () => {}
  }
  session.translator = createClaudeJournalTranslator({ sink })
  session.connection.send = (message, beforeDispatch) =>
    isSdkUserMessage(message)
      ? queue.push(message, beforeDispatch)
      : Promise.reject(new Error('dispatch wrote a non-user frame'))
  const pump = queue.messages[Symbol.asyncIterator]()
  const turnRow = (turnId: string) =>
    rows.get(agentJournalItemKey(claudeTurnLifecycleIdentity('provider-session', turnId)))
  const offer = (clientMessageId: string, beforeDispatch = async () => {}) =>
    dispatchClaudeTurn(session, { body: USER_MESSAGE, clientMessageId }, beforeDispatch)
  return { queue, session, pump, rows, turnRow, offer }
}

it('owns the run from the handoff and withdraws only an input Claude never ran', async () => {
  const rig = handoffRig()
  const refused = vi.fn()
  const refusedOptions = rig.offer('options-refused', async () => {
    throw new AgentSessionOptionRejectedError(new Error('model unavailable'))
  })
  const first = rig.offer('client-a')
  const joined = rig.offer('client-b')

  // Options refused before the handoff: nothing owns work for it.
  await expect(rig.pump.next()).resolves.toMatchObject({ done: false })
  await expect(refusedOptions).resolves.toMatchObject({ state: 'rejected' })
  const opener = rig.session.dispatchWaiters[0]!.sentUuid
  // Frames can arrive before the write resolves; the run already exists.
  expect(rig.session.translator?.currentTurnId).toBe(opener)
  expect(rig.turnRow(opener)).toMatchObject({ kind: 'turn', state: 'running' })
  expect(rig.rows.size).toBe(1)

  await rig.pump.next()
  await expect(first).resolves.toMatchObject({ state: 'admitted' })
  const follower = rig.session.dispatchWaiters[1]!.sentUuid
  // A follow-up handed over while the run is live joins it; Claude refusing it leaves the run.
  rejectClaudeDispatchWaiters(
    rig.session,
    [follower],
    agentSessionFailureFact('cancelled'),
    refused
  )
  expect(rig.session.translator?.currentTurnId).toBe(opener)
  expect(rig.turnRow(opener)).toMatchObject({ state: 'running' })

  // Claude refusing the opener before starting it retracts the unworked run: no duration, one refusal.
  rejectClaudeDispatchWaiters(
    rig.session,
    [opener],
    agentSessionFailureFact('providerRejected'),
    refused
  )
  expect(rig.session.translator?.currentTurnId).toBeNull()
  expect(rig.turnRow(opener)).toBe('tombstone')
  expect(refused.mock.calls.map(([settlement]) => settlement)).toEqual([
    expect.objectContaining({ clientMessageId: 'client-b', state: 'rejected', unrun: true }),
    expect.objectContaining({ clientMessageId: 'client-a', state: 'rejected', unrun: true })
  ])
  rig.queue.end()
  await rig.pump.next()
  await expect(joined).resolves.toMatchObject({ state: 'admitted' })
})

it('keeps the run when a write may have reached Claude', async () => {
  const rig = handoffRig()
  const ambiguous = rig.offer('client-a')
  await rig.pump.next()
  const opener = rig.session.dispatchWaiters[0]!.sentUuid
  // The SDK abandons the input stream after the frame was yielded.
  await rig.pump.return?.()
  await expect(ambiguous).resolves.toMatchObject({ state: 'unknown' })
  expect(rig.session.translator?.currentTurnId).toBe(opener)
  expect(rig.turnRow(opener)).toMatchObject({ state: 'running' })
})

it('keeps the run for the input that survives when Claude refuses the one that opened it', async () => {
  const rig = handoffRig()
  const first = rig.offer('client-a')
  await rig.pump.next()
  const joined = rig.offer('client-b')
  await rig.pump.next()
  await expect(first).resolves.toMatchObject({ state: 'admitted' })
  const [opener, follower] = rig.session.dispatchWaiters.map((waiter) => waiter.sentUuid)
  const refuse = (uuid: string) =>
    rejectClaudeDispatchWaiters(rig.session, [uuid!], agentSessionFailureFact('providerRejected'))

  refuse(opener!)
  // Same run and Stop target, now anchored at the input still owed.
  expect(rig.session.translator?.currentTurnId).toBe(opener)
  expect(rig.turnRow(opener!)).toMatchObject({
    state: 'running',
    userItemId: agentJournalSubmissionKey('client-b')
  })

  refuse(follower!)
  expect(rig.session.translator?.currentTurnId).toBeNull()
  expect(rig.turnRow(opener!)).toBe('tombstone')
  rig.queue.end()
  await rig.pump.next()
  await expect(joined).resolves.toMatchObject({ state: 'admitted' })
})

/** Offers and frames take acquisition's path: delivery resolution first, then the translator. */
function attributionRig() {
  const session = sessionFor()
  session.connection.send = async (_message, beforeDispatch) => {
    await beforeDispatch?.()
  }
  const translator = createClaudeJournalTranslator({
    sink: { appendItem: () => {}, appendTombstone: () => {}, publish: () => {} }
  })
  session.translator = translator
  let identityReads = 0
  const offerInput = translator.offerInput
  // Count every read of an offered input's identity, wherever the run model keeps it.
  translator.offerInput = (input) => {
    const { sessionId, sentUuid, clientMessageId } = input
    offerInput({
      sessionId,
      get sentUuid() {
        identityReads += 1
        return sentUuid
      },
      get clientMessageId() {
        identityReads += 1
        return clientMessageId
      }
    })
  }
  const frame = (message: Record<string, unknown>) => {
    const full = { session_id: 'provider-session', parent_tool_use_id: null, ...message }
    const origin = resolveClaudeReplayTurn(session, full)
    translator.handle({
      type: 'message',
      sessionId: 'session-1',
      message: full,
      ...(origin ? { startsTurn: true as const } : {}),
      ...(origin?.clientMessageId ? { clientMessageId: origin.clientMessageId } : {})
    })
  }
  const offer = (index: number) =>
    dispatchClaudeTurn(
      session,
      { body: USER_MESSAGE, clientMessageId: `client-${index}`, sentUuid: `sent-${index}` },
      async () => {}
    )
  const runsFolded = async (count: number) => {
    for (let index = 0; index <= count; index += 1) {
      await offer(index)
      frame({ type: 'command_lifecycle', state: 'started', command_uuid: `sent-${index}` })
      frame({
        type: 'user',
        uuid: `sent-${index}`,
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }
      })
    }
  }
  return { session, translator, frame, offer, runsFolded, reads: () => identityReads }
}

it('attributes receipts, echoes and named results by identity, not by the size of the run', async () => {
  const measure = async (count: number) => {
    const rig = attributionRig()
    await rig.runsFolded(count)
    // Every input folded into one live run, and no delivery waiter is left to bound it.
    expect(rig.translator.currentTurnId).toBe('sent-0')
    expect(rig.session.dispatchWaiters).toHaveLength(0)
    const beforeReceipt = rig.reads()
    rig.frame({ type: 'command_lifecycle', state: 'completed', command_uuid: 'sent-1' })
    const receipt = rig.reads() - beforeReceipt
    rig.frame({
      type: 'result',
      subtype: 'success',
      is_error: false,
      user_message_uuids: ['sent-0']
    })
    expect(rig.translator.currentTurnId).toBeNull()
    const total = rig.reads()
    // The run released every input: the next send anchors its own run.
    await rig.offer(count + 1)
    expect(rig.translator.currentTurnId).toBe(`sent-${count + 1}`)
    return { receipt, total }
  }
  const small = await measure(40)
  const large = await measure(400)
  expect(large.receipt).toBe(small.receipt)
  expect(large.total).toBeLessThanOrEqual(10 * small.total + 20)
})
