import './rpc/unused-default-rpc-methods.test-fixture'
// A busy structured chat holds the orchestration pointer as a card in its own queue, sent when the
// turn ends, as it holds a message the person sends then; the queue does nothing else with it. End
// to end on the coordinator-mail rig.

import { describe, expect, it, vi } from 'vitest'
import type { FakeConnection } from './structured-chat-coordinator-fake-codex-fixture'
import { idOf } from './rpc/orchestration-session-caller-test-fixture'
import {
  COORDINATOR,
  WORKER_2_PANE,
  WAIT,
  call,
  coordinatorRunAndTask,
  db,
  finishWorker,
  host,
  openChat,
  ptyPointer,
  queuedCardTexts,
  runtime,
  sendUserMessage,
  settleTurn,
  turnText
} from './structured-chat-coordinator-mail-rig.test-fixture'

/** The person's turn, started and still running; resolves to its end. */
async function runningUserTurn(chat: FakeConnection): Promise<() => Promise<void>> {
  expect(await sendUserMessage(COORDINATOR, 'go')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
  const notify = (method: string, params: unknown) => chat.handlers.onNotification?.(method, params)
  notify('turn/started', { turn: { id: 'turn-1' } })
  notify('item/completed', {
    item: {
      type: 'userMessage',
      id: 'echo-go',
      clientId: chat.turns[0]!.clientUserMessageId,
      content: [{ type: 'text', text: 'go' }]
    }
  })
  await host.flushStreamedEvents(COORDINATOR)
  return async () => {
    notify('turn/completed', { turn: { id: 'turn-1' } })
    await host.flushStreamedEvents(COORDINATOR)
  }
}

/** Idle edges with nothing owed: whatever they would send gets the time to show. */
async function idleEdgesSettled(): Promise<void> {
  for (let edge = 0; edge < 3; edge += 1) {
    runtime.onStructuredSessionStatusForMail({ sessionId: COORDINATOR, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** The chat's queue as its journal stores it. */
function queuedRows() {
  return host.collaboratorsForTests().sessions.get(COORDINATOR)?.journal.queuedMessages.list() ?? []
}

/** A second task, for a second worker result. */
async function secondTask(): Promise<string> {
  return idOf(
    (await call('orchestration.taskCreate', { spec: 'more' }, { sessionId: COORDINATOR })).task
  )
}

describe("a busy chat's orchestration pointer waits in its queue", () => {
  it('queues the pointer as a card, with who it is from, and sends it once when the turn ends', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)
    const dispatchId = await finishWorker(taskId)
    // The report was accepted, so its dispatch settled before its mail was named.
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('completed')
    await vi.waitFor(
      async () => expect(await queuedCardTexts()).toEqual([ptyPointer(`run:${runId}`)]),
      WAIT
    )
    expect(chat.turns).toHaveLength(1)
    const [card] = queuedRows()
    const [mail] = db.getAllMessages(`run:${runId}`)
    const from = {
      kind: 'agent',
      senders: [
        {
          party: { address: 'term_worker', terminalHandle: 'term_worker', orcaSessionId: null },
          // Named by the task of the dispatch it just finished, through the real runtime's naming.
          name: 'build it'
        }
      ],
      orchestration: {
        message: 'mail-notice',
        mailbox: `run:${runId}`,
        dispatchId: null,
        messages: [{ messageId: mail!.id, runId, from: 'term_worker' }]
      }
    }
    // On the card's body: the turn the queue sends carries it, and the provider never sees it.
    expect(card?.body.from).toEqual(from)

    await endTurn()
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    expect(turnText(chat.turns[1]!)).toBe(ptyPointer(`run:${runId}`))
    expect(JSON.stringify(chat.turns[1])).not.toContain('term_worker')
    const sent = (await host.journalSnapshot(COORDINATOR)).items.filter(
      (item) => item.body.kind === 'message' && item.body.from
    )
    expect(sent.map((item) => item.body.kind === 'message' && item.body.from)).toEqual([from])
    expect(await queuedCardTexts()).toEqual([])
    await settleTurn(COORDINATOR, 1)
    await idleEdgesSettled()
    expect(chat.turns).toHaveLength(2)
  })

  it('queues a second card for mail that arrives while the first waits, each counting its own mail', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const second = await secondTask()
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await queuedCardTexts()).toHaveLength(1), WAIT)
    await finishWorker(second, { handle: 'term_worker_2', paneKey: WORKER_2_PANE })
    const pointer = ptyPointer(`run:${runId}`)
    await vi.waitFor(async () => expect(await queuedCardTexts()).toEqual([pointer, pointer]), WAIT)

    await endTurn()
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    await settleTurn(COORDINATOR, 1)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(3), WAIT)
    expect(turnText(chat.turns[2]!)).toBe(pointer)
    await settleTurn(COORDINATOR, 2)
    await idleEdgesSettled()
    expect(chat.turns).toHaveLength(3)
    expect(await queuedCardTexts()).toEqual([])
  })

  it("leaves the chat's own `check` as it is: the mail stays readable, and the card stays", async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await queuedCardTexts()).toHaveLength(1), WAIT)
    const [mail] = db.getAllMessages(`run:${runId}`)
    expect(await call('orchestration.check', {}, { sessionId: COORDINATOR })).toMatchObject({
      count: 1,
      messages: [{ id: mail!.id }]
    })
    expect(await queuedCardTexts()).toEqual([ptyPointer(`run:${runId}`)])
    await endTurn()
  })
})
