import { describe, expect, it, vi } from 'vitest'

import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'

import '../../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'

import {
  COORDINATOR,
  codex,
  runtime,
  db,
  host,
  observationClock,
  call,
  openChat,
  connectionFor,
  settleTurn,
  sendUserMessage,
  finishWorker,
  coordinatorRunAndTask,
  clearChat,
  WAIT,
  isWholeMail,
  turnText
} from './structured-chat-coordinator-mail-rig.test-fixture'

/** Mail the chat has not been handed yet: `check` still returns it. */
const unread = (mailbox: string) => db.getUnreadMessages(mailbox)

describe('a worker result reaches the structured chat that coordinates it', () => {
  /** Fires both edges and waits until every gate read they started has answered. */
  const edgesAnswered = (): Promise<void> => observationClock.edgesAnswered(runtime, WAIT)

  /** The operation ids the coordinator's journal recorded for whole-mail turns. */
  async function mailSends(): Promise<string[]> {
    const snapshot = await host.journalSnapshot(COORDINATOR)
    return snapshot.submissions
      .filter((submission) =>
        snapshot.items.some(
          (item) =>
            item.itemId === agentJournalSubmissionKey(submission.clientMessageId) &&
            item.body?.kind === 'message' &&
            item.body.blocks.some((block) => block.type === 'text' && isWholeMail(block.text))
        )
      )
      .map((submission) => submission.clientMessageId)
  }

  it('never hands a report the provider may have taken over again, even after a later turn; check keeps it', async () => {
    // Death before the echo leaves the report in doubt: it may have reached the agent, so only check returns it.
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    await finishWorker(taskId)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)

    chat.handlers.onExit?.(new Error('provider died before the echo'))
    const before = codex.connections.length
    await edgesAnswered()
    await edgesAnswered()
    expect(codex.connections.length).toBe(before)
    expect(unread(`run:${runId}`)).toHaveLength(1)

    expect(await sendUserMessage(COORDINATOR, 'again')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(codex.connections.length).toBe(before + 1), WAIT)
    const revived = connectionFor(COORDINATOR)
    await vi.waitFor(() => expect(revived.turns).toHaveLength(1), WAIT)
    expect(revived.turns[0]!.text).toContain('again')
    await settleTurn(COORDINATOR, 0)
    await edgesAnswered()
    expect(revived.turns).toHaveLength(1)
    expect(await mailSends()).toHaveLength(1)
    const checked = await call('orchestration.check', {}, { sessionId: COORDINATOR })
    expect(checked).toMatchObject({ runId, count: 1, messages: [{ type: 'worker_done' }] })
  })
})

describe('a /clear keeps the chat its orchestration address', () => {
  it("delivers the conversation's Run to its fresh context under the same address", async () => {
    await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const generation = db.getRunRaw(runId)!.consumer_generation
    const cleared = await clearChat(COORDINATOR)
    expect(cleared).toBe(COORDINATOR)
    const opened = codex.connections.length

    await finishWorker(taskId)
    await vi.waitFor(() => expect(connectionFor(cleared).turns).toHaveLength(1), WAIT)
    const next = connectionFor(cleared)
    expect(codex.connections.slice(opened)).toEqual([next])
    expect(next.methods.filter((method) => method.startsWith('thread/'))).toEqual(['thread/start'])
    expect(isWholeMail(turnText(next.turns[0]!))).toBe(true)
    await settleTurn(cleared, 0)
    await expect(
      call('orchestration.runCurrent', {}, { sessionId: cleared })
    ).resolves.toMatchObject({ run: { id: runId } })
    await vi.waitFor(() => expect(unread(`run:${runId}`)).toEqual([]), WAIT)
    expect(db.getRunRaw(runId)).toMatchObject({
      coordinator_orca_session_id: COORDINATOR,
      consumer_generation: generation
    })
  })
})
