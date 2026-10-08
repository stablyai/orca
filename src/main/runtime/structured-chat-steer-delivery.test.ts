import './rpc/unused-default-rpc-methods.test-fixture'
// An agent's message sent with `--delivery steer` into a chat mid-turn, end to end on the
// coordinator-mail rig: it takes the composer's send-now path instead of waiting as a queued card,
// and never goes past an approval the person has not answered. The rig's provider refuses
// `turn/steer`, so these prove the path taken, not how a real provider folds the message in.

import { describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { formatOrcaSessionAddress } from '../../shared/orca-session-address'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import { idOf } from './rpc/orchestration-session-caller-test-fixture'
import { operationId, type FakeConnection } from './structured-chat-coordinator-fake-codex-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  call,
  coordinatorRunAndTask,
  host,
  openChat,
  queuedCardTexts,
  sendUserMessage,
  settleTurn,
  turnText
} from './structured-chat-coordinator-mail-rig.test-fixture'

const WORKER = formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))
const POINTER = /^You have 1 orchestration message\./

/** A person's turn in the peer chat, started and still running; resolves to its end. */
async function runningUserTurn(chat: FakeConnection): Promise<() => Promise<void>> {
  expect(await sendUserMessage(PEER_CHAT, 'go')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
  const notify = (method: string, params: unknown) => chat.handlers.onNotification?.(method, params)
  notify('turn/started', { turn: { id: 'user-0' } })
  notify('item/completed', {
    item: {
      type: 'userMessage',
      id: 'echo-user-0',
      clientId: chat.turns[0]!.clientUserMessageId,
      content: [{ type: 'text', text: 'go' }]
    }
  })
  await host.flushStreamedEvents(PEER_CHAT)
  return async () => {
    notify('turn/completed', { turn: { id: 'user-0' } })
    await host.flushStreamedEvents(PEER_CHAT)
  }
}

/** The running turn asks to run a command; resolves to the person approving it. */
async function pendingApproval(chat: FakeConnection): Promise<() => Promise<void>> {
  chat.handlers.onNotification?.('item/started', {
    item: { type: 'commandExecution', id: 'item-cmd', command: 'ls', status: 'inProgress' }
  })
  chat.handlers.onServerRequest?.({
    id: 7,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: chat.threadId,
      turnId: 'user-0',
      itemId: 'item-cmd',
      availableDecisions: ['accept', 'decline']
    }
  })
  await host.flushStreamedEvents(PEER_CHAT)
  const approval = (await host.journalSnapshot(PEER_CHAT)).items.find(
    (item) => item.body.kind === 'approval'
  )
  expect(approval).toBeDefined()
  return async () => {
    const fields = {
      itemId: approval!.itemId,
      expectedRevision: approval!.revision,
      optionId: 'accept'
    }
    const answered = await host.respondToPrompt(
      { callerKey: 'test-surface' },
      {
        envelope: {
          sessionId: PEER_CHAT,
          clientOperationId: operationId(),
          expectedRuntimeFence: host.deps.store.getRecord(PEER_CHAT)!.lease.runtimeFence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.respondTo:approval',
            sessionId: PEER_CHAT,
            fields
          })
        },
        kind: 'approval',
        ...fields
      }
    )
    expect(answered).toMatchObject({ ok: true })
    await host.flushStreamedEvents(PEER_CHAT)
  }
}

/** The peer chat as the assignee of a Dispatch with no task sent; its mailbox address. */
async function chatDispatch(): Promise<{ chat: FakeConnection; mailbox: string }> {
  await openChat(COORDINATOR)
  const chat = await openChat(PEER_CHAT)
  const { taskId } = await coordinatorRunAndTask()
  const result = await call(
    'orchestration.dispatch',
    { task: taskId, to: WORKER },
    { sessionId: COORDINATOR }
  )
  return { chat, mailbox: `dispatch:${idOf(result.dispatch)}` }
}

describe('mail sent to steer into a chat mid-turn', () => {
  it('takes the send-now path into a running turn, with no card', async () => {
    const { chat, mailbox } = await chatDispatch()
    const endTurn = await runningUserTurn(chat)

    await call(
      'orchestration.send',
      { to: mailbox, subject: 'wrong branch, stop', delivery: 'steer' },
      { sessionId: COORDINATOR }
    )

    await vi.waitFor(() => expect(chat.methods).toContain('turn/steer'), WAIT)
    // The rig's provider refuses the steer, so the send falls back to its own turn.
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    expect(turnText(chat.turns[1]!)).toMatch(POINTER)
    expect(await queuedCardTexts(PEER_CHAT)).toEqual([])
    await settleTurn(PEER_CHAT, 1)
    await endTurn()
  })

  it('waits out an open approval, then takes the send-now path once it is answered', async () => {
    const { chat, mailbox } = await chatDispatch()
    const endTurn = await runningUserTurn(chat)
    const approve = await pendingApproval(chat)

    await call(
      'orchestration.send',
      { to: mailbox, subject: 'wrong branch, stop', delivery: 'steer' },
      { sessionId: COORDINATOR }
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(chat.methods).not.toContain('turn/steer')
    expect(chat.turns).toHaveLength(1)
    expect(await queuedCardTexts(PEER_CHAT)).toEqual([])

    // This chat is no worker-start session, so its status edge is what redrives the held mail.
    await approve()
    await vi.waitFor(() => expect(chat.methods).toContain('turn/steer'), WAIT)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    expect(turnText(chat.turns[1]!)).toMatch(POINTER)
    await settleTurn(PEER_CHAT, 1)
    await endTurn()
  })

  it('takes the send-now path when the prompt is answered while its first attempt is reading', async () => {
    const { chat, mailbox } = await chatDispatch()
    const endTurn = await runningUserTurn(chat)
    const approve = await pendingApproval(chat)
    // The attempt's read sees the prompt open, then waits until after the person answers.
    let releaseRead = (): void => undefined
    const readHeld = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const readStarted = vi.fn()
    const journalSnapshot = host.journalSnapshot.bind(host)
    vi.spyOn(host, 'journalSnapshot').mockImplementationOnce(async (sessionId) => {
      const stale = await journalSnapshot(sessionId)
      readStarted()
      await readHeld
      return stale
    })

    await call(
      'orchestration.send',
      { to: mailbox, subject: 'wrong branch, stop', delivery: 'steer' },
      { sessionId: COORDINATOR }
    )
    await vi.waitFor(() => expect(readStarted).toHaveBeenCalled(), WAIT)
    await approve()
    releaseRead()

    await vi.waitFor(() => expect(chat.methods).toContain('turn/steer'), WAIT)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    expect(turnText(chat.turns[1]!)).toMatch(POINTER)
    await settleTurn(PEER_CHAT, 1)
    await endTurn()
  })
})

describe('a task dispatched to steer into a chat mid-turn', () => {
  it('takes the send-now path into a running turn and reports the hand-off without waiting for it to be taken', async () => {
    await openChat(COORDINATOR)
    const chat = await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)

    // Nothing settles the steered send: the provider takes it at its own next step.
    const result = await call(
      'orchestration.dispatch',
      { task: taskId, to: WORKER, inject: true, delivery: 'steer' },
      { sessionId: COORDINATOR }
    )

    expect(result).toMatchObject({ injected: true, delivery: 'pending' })
    expect(await queuedCardTexts(PEER_CHAT)).toEqual([])
    // The hand-over to the provider follows the answer.
    await vi.waitFor(() => expect(chat.methods).toContain('turn/steer'), WAIT)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    expect(turnText(chat.turns[1]!)).toContain(idOf(result.dispatch))
    await settleTurn(PEER_CHAT, 1)
    await endTurn()
  })

  it('still waits out the start of an idle chat, and reports it taken', async () => {
    await openChat(COORDINATOR)
    const chat = await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()

    const dispatched = call(
      'orchestration.dispatch',
      { task: taskId, to: WORKER, inject: true, delivery: 'steer' },
      { sessionId: COORDINATOR }
    )
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    await settleTurn(PEER_CHAT, 0)

    expect(await dispatched).toMatchObject({ injected: true, delivery: 'accepted' })
  })

  it('queues it as a card, and reports that, while an approval is open', async () => {
    await openChat(COORDINATOR)
    const chat = await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)
    await pendingApproval(chat)

    const result = await call(
      'orchestration.dispatch',
      { task: taskId, to: WORKER, inject: true, delivery: 'steer' },
      { sessionId: COORDINATOR }
    )

    expect(result).toMatchObject({ injected: true, delivery: 'queued' })
    expect(chat.methods).not.toContain('turn/steer')
    expect(await queuedCardTexts(PEER_CHAT)).toHaveLength(1)
    await endTurn()
  })

  it('reports a default dispatch into a busy chat as queued', async () => {
    await openChat(COORDINATOR)
    const chat = await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)

    const result = await call(
      'orchestration.dispatch',
      { task: taskId, to: WORKER, inject: true },
      { sessionId: COORDINATOR }
    )

    expect(result).toMatchObject({ injected: true, delivery: 'queued' })
    expect(chat.methods).not.toContain('turn/steer')
    await endTurn()
  })
})
