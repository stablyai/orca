import './rpc/dispatch/testing/unused-default-rpc-methods.test-fixture'
// A background chat (a bot's thread, say) coordinates its workers with no tab: a worker's report
// must still wake it, while a chat a person closed keeps its mail waiting.

import { describe, expect, it, vi } from 'vitest'
import {
  COORDINATOR,
  WAIT,
  codex,
  connectionFor,
  coordinatorRunAndTask,
  db,
  finishWorker,
  host,
  isWholeMail,
  openChat,
  root,
  runtime,
  threadBySession,
  turnText
} from './orchestration/terminal-authority/structured-sessions/structured-chat-coordinator-mail-rig.test-fixture'
import { attachParams } from './orchestration/terminal-authority/structured-sessions/structured-chat-coordinator-fake-codex-fixture'
import {
  captureStructuredSessionSurface,
  retireCapturedStructuredSessionSurface
} from './agent-session/lifecycle/structured-agent-session-close'
import { runsForBot } from '../bots/bot-session-tabs'
import { makeTestBot } from '../bots/bot.test-fixture'

/** What a background chat (a bot's thread or run) gets: no tab, and still open. */
function moveToBackground(sessionId: string): Promise<void> {
  return host.setSessionTabVisibility(sessionId, false, undefined, { background: true })
}

/** Finishes the worker and waits until mail reach has judged the tabless chat, so no turn is a verdict. */
async function finishWorkerAndJudgeReach(taskId: string, sessionId: string): Promise<void> {
  const read = vi.spyOn(host.deps.store, 'isSessionInBackground')
  await finishWorker(taskId)
  await vi.waitFor(() => expect(read).toHaveBeenCalledWith(sessionId), WAIT)
  await new Promise((resolve) => setImmediate(resolve))
}

describe('a coordinator chat with no tab', () => {
  it("that runs in the background is woken by its worker's report", async () => {
    const chat = await openChat(COORDINATOR)
    await moveToBackground(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()

    await finishWorker(taskId)

    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    expect(isWholeMail(turnText(chat.turns[0]!))).toBe(true)
  })

  it('whose agent has stopped is started by the report, as a tabbed chat is', async () => {
    await openChat(COORDINATOR)
    await moveToBackground(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    await host.close(COORDINATOR, 'evict')
    const before = codex.connections.length

    await finishWorker(taskId)

    await vi.waitFor(() => expect(codex.connections.length).toBe(before + 1), WAIT)
    // The new app-server names its thread once it resumes it.
    await vi.waitFor(() => expect(connectionFor(COORDINATOR)).toBe(codex.connections.at(-1)), WAIT)
    const revived = connectionFor(COORDINATOR)
    await vi.waitFor(() => expect(revived.turns).toHaveLength(1), WAIT)
    expect(isWholeMail(turnText(revived.turns[0]!))).toBe(true)
  })

  it('that a person closed is not revived; its mail waits', async () => {
    const chat = await openChat(COORDINATOR)
    await host.setSessionTabVisibility(COORDINATOR, false)
    const { runId, taskId } = await coordinatorRunAndTask()

    await finishWorkerAndJudgeReach(taskId, COORDINATOR)

    expect(chat.turns).toHaveLength(0)
    expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toHaveLength(1)
  })

  it('that was shown and then closed by a person is closed; its mail waits', async () => {
    const chat = await openChat(COORDINATOR)
    await moveToBackground(COORDINATOR)
    await host.setSessionTabVisibility(COORDINATOR, true)
    await host.setSessionTabVisibility(COORDINATOR, false)
    const { runId, taskId } = await coordinatorRunAndTask()

    await finishWorkerAndJudgeReach(taskId, COORDINATOR)

    expect(chat.turns).toHaveLength(0)
    expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toHaveLength(1)
  })

  it("that is a bot's thread, whose tab a person closed, is still woken by its worker's report", async () => {
    vi.spyOn(runtime.bots, 'list').mockReturnValue([makeTestBot({ folderWorkspaceId: 'bot-home' })])
    const attached = await host.attach(
      { callerKey: 'test-surface' },
      attachParams(COORDINATOR, root, 'bot-home')
    )
    expect(attached).toMatchObject({ ok: true })
    await host.setSessionTabVisibility(COORDINATOR, true)
    threadBySession.set(COORDINATOR, codex.connections.at(-1)!.threadId!)
    const chat = connectionFor(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()

    // As agentSession.close does; this runtime has no window presentation to capture.
    const keepRunning = runsForBot(runtime.bots, COORDINATOR)
    const surface = captureStructuredSessionSurface(host, COORDINATOR)
    await retireCapturedStructuredSessionSurface(host, COORDINATOR, surface, undefined, keepRunning)
    expect(keepRunning).toBe(true)
    expect(host.getSessionTabId(COORDINATOR)).toBeNull()
    await finishWorker(taskId)

    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    expect(isWholeMail(turnText(chat.turns[0]!))).toBe(true)
  })
})
