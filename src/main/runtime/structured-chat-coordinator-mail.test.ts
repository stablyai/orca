import './rpc/unused-default-rpc-methods.test-fixture'

import { describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import {
  AgentSessionAcquisitionRefusal,
  AgentSessionPreSpawnError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { currentRunCoordinatorOrcaSessionId } from './orchestration/db/runs/run-coordinator-orca-session'
import { idOf } from './rpc/orchestration-session-caller-test-fixture'
import { operationId, providerFaults } from './structured-chat-coordinator-fake-codex-fixture'

import {
  COORDINATOR,
  PEER_CHAT,
  WORKER_2_PANE,
  codex,
  runtime,
  db,
  host,
  dispatcher,
  observationClock,
  request,
  call,
  openChat,
  connectionFor,
  settleTurn,
  sendUserMessage,
  userTexts,
  finishWorker,
  coordinatorRunAndTask,
  clearChat,
  startClearedContext,
  WAIT,
  isWholeMail,
  turnText,
  queuedCardTexts,
  restartRuntime
} from './structured-chat-coordinator-mail-rig.test-fixture'

/** Mail the chat has not been handed yet: `check` still returns it. */
const unread = (mailbox: string) => db.getUnreadMessages(mailbox)

describe('a worker result reaches the structured chat that coordinates it', () => {
  it('hands an idle coordinator the whole worker report as its own turn, leaving check nothing', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()

    await finishWorker(taskId)

    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    const text = turnText(chat.turns[0]!)
    expect(isWholeMail(text)).toBe(true)
    expect(text).toContain('(worker_done)')
    await settleTurn(COORDINATOR, 0)
    expect(await userTexts(COORDINATOR)).toEqual([text])
    await vi.waitFor(() => expect(unread(`run:${runId}`)).toEqual([]), WAIT)

    const checked = await call('orchestration.check', {}, { sessionId: COORDINATOR })
    expect(checked).toMatchObject({ runId, count: 0 })
  })

  it('does not send a report twice when the delivery is retried', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    await finishWorker(taskId)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)

    runtime.deliverPendingMessagesForHandle(`run:${runId}`)
    await settleTurn(COORDINATOR, 0)
    runtime.deliverPendingMessagesForHandle(`run:${runId}`)
    await vi.waitFor(() => expect(unread(`run:${runId}`)).toEqual([]), WAIT)
    expect(chat.turns).toHaveLength(1)
    expect(await userTexts(COORDINATOR)).toHaveLength(1)
  })

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

  it('keeps a report whose provider died before the echo, and hands it over after the next turn that runs', async () => {
    // Death before echo leaves the report unread; death/idle edges must not restart the provider for it.
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
    await vi.waitFor(() => expect(revived.turns).toHaveLength(2), WAIT)
    expect(isWholeMail(turnText(revived.turns[1]!))).toBe(true)
    await settleTurn(COORDINATOR, 1)
    await vi.waitFor(() => expect(unread(`run:${runId}`)).toEqual([]), WAIT)
  })

  it('does not restart a provider that dies before every echo, however many edges follow', async () => {
    observationClock.start()
    await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    providerFaults.dieBeforeEveryEcho = true
    const before = codex.connections.length
    await finishWorker(taskId)
    await vi.waitFor(() => expect(providerFaults.turnStarts).toBe(1), WAIT)
    // A fixed window, not a poll: a respawn loop would restart it several times in it.
    await observationClock.observe(1_500)
    await edgesAnswered()
    expect(codex.connections.length - before).toBe(0)
    expect(providerFaults.turnStarts).toBe(1)
    expect(unread(`run:${runId}`)).toHaveLength(1)
  })

  it.each(['exit-then-throw', 'throw-then-exit'] as const)(
    'does not restart a provider that crashed while taking the report turn (%s)',
    async (crash) => {
      observationClock.start()
      await openChat(COORDINATOR)
      const { runId, taskId } = await coordinatorRunAndTask()
      providerFaults.crashOnTurnStart = crash
      const before = providerFaults.starts
      await finishWorker(taskId)
      await vi.waitFor(() => expect(providerFaults.turnStarts).toBe(1), WAIT)
      await observationClock.observe(1_500)
      await edgesAnswered()
      expect(providerFaults.starts - before).toBe(0)
      expect(providerFaults.turnStarts).toBe(1)
      expect(await mailSends()).toHaveLength(1)
      expect(unread(`run:${runId}`)).toHaveLength(1)
    }
  )

  it('hands the next report over after a transient death, then the one the death left unread', async () => {
    await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const second = await call(
      'orchestration.taskCreate',
      { spec: 'more' },
      { sessionId: COORDINATOR }
    )
    providerFaults.dieBeforeEveryEcho = true
    await finishWorker(taskId)
    await vi.waitFor(() => expect(providerFaults.turnStarts).toBe(1), WAIT)
    await edgesAnswered()
    providerFaults.dieBeforeEveryEcho = false
    const before = providerFaults.starts
    await finishWorker(idOf(second.task), { handle: 'term_worker_2', paneKey: WORKER_2_PANE })
    await vi.waitFor(() => expect(providerFaults.turnStarts).toBe(2), WAIT)
    const revived = connectionFor(COORDINATOR)
    expect(isWholeMail(turnText(revived.turns.at(-1)!))).toBe(true)
    await settleTurn(COORDINATOR, revived.turns.length - 1)
    // The report the death left in doubt follows as its own turn once a turn has run.
    await vi.waitFor(() => expect(providerFaults.turnStarts).toBe(3), WAIT)
    expect(isWholeMail(turnText(revived.turns.at(-1)!))).toBe(true)
    await settleTurn(COORDINATOR, revived.turns.length - 1)
    await vi.waitFor(() => expect(unread(`run:${runId}`)).toEqual([]), WAIT)
    expect(providerFaults.starts - before).toBe(1)
  })

  it('leaves a report the person stopped while its agent was starting stopped', async () => {
    observationClock.start()
    await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    await host.close(COORDINATOR, 'evict')
    providerFaults.startDelayMs = 400
    const before = providerFaults.starts
    await finishWorker(taskId)
    await vi.waitFor(() => expect(providerFaults.starts).toBe(before + 1), WAIT)
    const cancelling = host.cancel(
      { callerKey: 'test-surface' },
      {
        envelope: {
          sessionId: COORDINATOR,
          clientOperationId: operationId(),
          expectedRuntimeFence: host.deps.store.getRecord(COORDINATOR)!.lease.runtimeFence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.cancel',
            sessionId: COORDINATOR,
            fields: { turnId: 'turn-x' }
          })
        },
        turnId: 'turn-x'
      }
    )
    await observationClock.observe(400)
    const cancelled = await cancelling
    expect(cancelled).toMatchObject({ ok: true })
    providerFaults.startDelayMs = 0
    // A fixed window, not a poll: a repeat would start the agent again in it.
    await observationClock.observe(1_500)
    expect(providerFaults.starts - before).toBe(1)
    expect(await mailSends()).toHaveLength(1)
    await edgesAnswered()
    expect(providerFaults.starts - before).toBe(1)
    expect(providerFaults.turnStarts).toBe(0)
    expect(unread(`run:${runId}`)).toHaveLength(1)
  })

  it('keeps a report in doubt across an Orca restart without restarting its agent', async () => {
    observationClock.start()
    await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    providerFaults.dieBeforeEveryEcho = true
    await finishWorker(taskId)
    await vi.waitFor(() => expect(providerFaults.turnStarts).toBe(1), WAIT)
    await edgesAnswered()
    const sends = await mailSends()

    // A fresh runtime reads the restored record; the still-failing provider must not enter a restart loop.
    restartRuntime()
    const before = providerFaults.starts
    await observationClock.observe(2_000)
    await edgesAnswered()
    expect(providerFaults.starts - before).toBe(0)
    expect(providerFaults.turnStarts).toBe(1)
    expect(await mailSends()).toEqual(sends)
    expect(unread(`run:${runId}`)).toHaveLength(1)
  })

  /** Mail for a chat whose agent is stopped and whose every start is refused; resolves after it. */
  async function refusedStartsFor(
    refusal: () => Error
  ): Promise<{ runId: string; starts: number }> {
    observationClock.start()
    await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    await host.close(COORDINATOR, 'evict')
    providerFaults.refuseStart = refusal
    const before = providerFaults.starts
    await finishWorker(taskId)
    await vi.waitFor(() => expect(providerFaults.starts).toBe(before + 1), WAIT)
    await vi.waitFor(() => expect(unread(`run:${runId}`)).toHaveLength(1), WAIT)
    // A fixed window, not a poll: a retry loop would start it several times in it.
    await observationClock.observe(1_500)
    return { runId, starts: providerFaults.starts - before }
  }

  it.each([
    [
      'one the person must fix',
      () => new AgentSessionAcquisitionRefusal('no login', 'notSignedIn')
    ],
    [
      'an account switch in progress',
      () =>
        new AgentSessionPreSpawnError(new Error('switching accounts'), {
          reason: 'accountSwitchInProgress'
        })
    ]
  ])(
    'holds a report after a start refused as %s until a turn runs, adding nothing on later edges',
    async (_label, refusal) => {
      const { runId, starts } = await refusedStartsFor(refusal)
      expect(starts).toBe(1)
      const before = providerFaults.starts
      for (let edge = 0; edge < 5; edge += 1) {
        runtime.onStructuredSessionStatusForMail({ sessionId: COORDINATOR, status: 'idle' })
        await observationClock.observe(100)
      }
      await edgesAnswered()
      expect(providerFaults.starts).toBe(before)
      expect(await mailSends()).toHaveLength(1)
      expect(unread(`run:${runId}`)).toHaveLength(1)

      providerFaults.refuseStart = null
      expect(await sendUserMessage(COORDINATOR, 'again')).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(providerFaults.starts).toBe(before + 1), WAIT)
      const revived = connectionFor(COORDINATOR)
      await vi.waitFor(() => expect(revived.turns.length).toBeGreaterThanOrEqual(1), WAIT)
      expect(revived.turns[0]!.text).toContain('again')
      await settleTurn(COORDINATOR, 0)
      await vi.waitFor(() => expect(revived.turns).toHaveLength(2), WAIT)
      expect(isWholeMail(turnText(revived.turns[1]!))).toBe(true)
    }
  )

  it('hands a report over after the next turn that runs, even once a rewind dropped its send', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    providerFaults.crashOnTurnStart = 'exit-then-throw'
    await finishWorker(taskId)
    await vi.waitFor(() => expect(providerFaults.turnStarts).toBe(1), WAIT)
    await edgesAnswered()
    // What a rewind's recovery does: the journal is rebuilt, and no send is on record any more.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host keeps its conversations private; this is the one journal call rewind recovery makes.
    const open = (host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> })
      .sessions
    const fence = host.deps.store.getRecord(COORDINATOR)!.lease.runtimeFence
    await open.get(COORDINATOR)!.journal.replaceEpochItems('handle_forked', fence, [])
    expect(await mailSends()).toEqual([])

    providerFaults.crashOnTurnStart = 'off'
    expect(await sendUserMessage(COORDINATOR, 'again')).toMatchObject({ ok: true })
    const revived = await vi.waitFor(() => {
      const connection = connectionFor(COORDINATOR)
      expect(connection).not.toBe(chat)
      return connection
    }, WAIT)
    await vi.waitFor(async () => {
      const index = revived.turns.length - 1
      await settleTurn(COORDINATOR, index)
      expect(unread(`run:${runId}`)).toEqual([])
    }, WAIT)
    expect(revived.turns.map(turnText).filter(isWholeMail)).toHaveLength(1)
  })

  it('starts a coordinator whose agent is not running through the send alone', async () => {
    await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    await host.close(COORDINATOR, 'evict')
    expect(host.hasSession(COORDINATOR)).toBe(false)
    const before = codex.connections.length

    await finishWorker(taskId)

    // Nothing holds or wakes the session first: the report's accepted send starts its agent.
    await vi.waitFor(() => expect(codex.connections.length).toBe(before + 1), WAIT)
    const revived = connectionFor(COORDINATOR)
    await vi.waitFor(() => expect(revived.turns).toHaveLength(1), WAIT)
    expect(isWholeMail(turnText(revived.turns[0]!))).toBe(true)
    await settleTurn(COORDINATOR, 0)
    expect((await userTexts(COORDINATOR)).filter(isWholeMail)).toHaveLength(1)
  })

  it('queues a report that arrives mid-turn as a card the next turn takes, with who it is from', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    expect(await sendUserMessage(COORDINATOR, 'go')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    const notify = (method: string, params: unknown) =>
      chat.handlers.onNotification?.(method, params)
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

    await finishWorker(taskId)

    // Queued like a person's message sent mid-turn: never steered into the running turn.
    await vi.waitFor(async () => expect(await queuedCardTexts()).toHaveLength(1), WAIT)
    const [card] = await queuedCardTexts()
    expect(isWholeMail(card!)).toBe(true)
    expect(chat.steers).toHaveLength(0)
    // The chat holds it, so check still shows it until the agent is handed it.
    expect(unread(`run:${runId}`)).toHaveLength(1)

    notify('turn/completed', { turn: { id: 'turn-1' } })
    await host.flushStreamedEvents(COORDINATOR)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    expect(turnText(chat.turns[1]!)).toBe(card)
    const sent = (await host.journalSnapshot(COORDINATOR)).items.find(
      (item) => item.body.kind === 'message' && item.body.from
    )
    expect(sent?.body).toMatchObject({
      from: { kind: 'agent', orchestration: { message: 'mail-notice', mailbox: `run:${runId}` } }
    })
    await settleTurn(COORDINATOR, 1)
    runtime.onStructuredSessionStatusForMail({ sessionId: COORDINATOR, status: 'idle' })
    await vi.waitFor(() => expect(unread(`run:${runId}`)).toEqual([]), WAIT)
    expect(chat.steers).toHaveLength(0)
  })

  it('deletes the waiting card when a check takes its report first', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    expect(await sendUserMessage(COORDINATOR, 'go')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    chat.handlers.onNotification?.('turn/started', { turn: { id: 'turn-1' } })
    await host.flushStreamedEvents(COORDINATOR)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await queuedCardTexts()).toHaveLength(1), WAIT)

    const checked = await call('orchestration.check', {}, { sessionId: COORDINATOR })
    expect(checked).toMatchObject({ runId, count: 1, messages: [{ type: 'worker_done' }] })
    await vi.waitFor(async () => expect(await queuedCardTexts()).toEqual([]), WAIT)
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

  it('hands mail the earlier context never took to the fresh context, without a user message', async () => {
    observationClock.start()
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    await finishWorker(taskId)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    // The provider dies before it runs the report, so the earlier context never took it.
    chat.handlers.onExit?.(new Error('provider died before the echo'))
    await vi.waitFor(() =>
      expect(host.deps.store.getRecord(COORDINATOR)?.lease.claimStatus).toBe('released')
    )
    expect(unread(`run:${runId}`)).toHaveLength(1)

    const cleared = await clearChat(COORDINATOR)
    expect(cleared).toBe(COORDINATOR)
    await observationClock.observe(2_000)
    await vi.waitFor(
      () => expect(isWholeMail(turnText(connectionFor(cleared).turns[0]!))).toBe(true),
      WAIT
    )
    await settleTurn(cleared, 0)
    await vi.waitFor(() => expect(unread(`run:${runId}`)).toEqual([]), WAIT)
  })

  it('keeps a Run under the same conversation address through repeated clears', async () => {
    await openChat(COORDINATOR)
    const firstClear = await clearChat(COORDINATOR)
    await startClearedContext(firstClear)
    const created = await call(
      'orchestration.runCreate',
      { objective: 'next' },
      { sessionId: firstClear }
    )
    const runId = idOf(created.run)
    expect(db.getRunRaw(runId)!.coordinator_orca_session_id).toBe(COORDINATOR)
    const cleared = await clearChat(firstClear)
    await startClearedContext(cleared)

    await expect(
      call('orchestration.runCurrent', {}, { sessionId: cleared })
    ).resolves.toMatchObject({ run: { id: runId } })
    expect(db.getRunRaw(runId)!.coordinator_orca_session_id).toBe(COORDINATOR)
    await openChat(PEER_CHAT)
    await expect(
      call(
        'orchestration.send',
        { to: `orca_session_id:${PEER_CHAT}`, subject: 'hi' },
        { sessionId: cleared }
      )
    ).resolves.toMatchObject({ message: { from_handle: `orca_session_id:${COORDINATOR}` } })
  })

  it('binds a Run a cleared chat creates or uses to the same conversation at the current generation', async () => {
    const root = COORDINATOR
    const boundOrcaSessionId = (runId: string): string | null =>
      currentRunCoordinatorOrcaSessionId(db.getRunRaw(runId)!)
    await openChat(COORDINATOR)
    const firstClear = await clearChat(COORDINATOR)
    await startClearedContext(firstClear)
    const first = idOf(
      (await call('orchestration.runCreate', { objective: 'first' }, { sessionId: firstClear })).run
    )
    expect(db.getRunRaw(first)).toMatchObject({
      coordinator_orca_session_id: root,
      coordinator_orca_session_id_generation: db.getRunRaw(first)!.consumer_generation
    })
    expect(boundOrcaSessionId(first)).toBe(root)
    const second = idOf(
      (await call('orchestration.runCreate', { objective: 'second' }, { sessionId: firstClear }))
        .run
    )
    // A later run-create keeps the earlier Run; the run-use below keeps only the one it names.
    expect(boundOrcaSessionId(first)).toBe(root)

    const cleared = await clearChat(firstClear)
    await startClearedContext(cleared)
    await call('orchestration.runUse', { id: first }, { sessionId: cleared })
    const rebound = db.getRunRaw(first)!
    expect(rebound.coordinator_orca_session_id).toBe(root)
    expect(rebound.coordinator_orca_session_id_generation).toBe(rebound.consumer_generation)
    expect(boundOrcaSessionId(second)).toBeNull()
    await expect(
      call('orchestration.runCurrent', {}, { sessionId: cleared })
    ).resolves.toMatchObject({ run: { id: first } })
  })

  it('lands successive mail at the same conversation after repeated clears', async () => {
    await openChat(PEER_CHAT)
    const firstClear = await clearChat(PEER_CHAT)
    const cleared = await clearChat(firstClear)
    expect(firstClear).toBe(PEER_CHAT)
    expect(cleared).toBe(PEER_CHAT)
    // The first ping starts the fresh context, which neither clear did.
    for (const [index, spelling] of [PEER_CHAT, firstClear, cleared].entries()) {
      const sent = await call('orchestration.send', {
        from: 'term_worker',
        to: `orca_session_id:${spelling}`,
        subject: `ping ${index}`
      })
      expect(sent).toMatchObject({ message: { to_handle: `orca_session_id:${PEER_CHAT}` } })
      await vi.waitFor(() => expect(connectionFor(cleared).turns).toHaveLength(index + 1), WAIT)
      expect(turnText(connectionFor(cleared).turns[index]!)).toContain(`Subject: ping ${index}`)
      await settleTurn(cleared, index)
      await vi.waitFor(() => expect(unread(`orca_session_id:${PEER_CHAT}`)).toEqual([]), WAIT)
    }
  })
})

describe('any live session is addressable by its id', () => {
  it('lands mail sent to `orca_session_id:<id>` whole as a turn in that chat', async () => {
    const peer = await openChat(PEER_CHAT)

    const sent = await call('orchestration.send', {
      from: 'term_worker',
      to: `orca_session_id:${PEER_CHAT}`,
      subject: 'ping'
    })
    expect(sent).toMatchObject({ message: { to_handle: `orca_session_id:${PEER_CHAT}` } })

    await vi.waitFor(() => expect(peer.turns).toHaveLength(1), WAIT)
    const text = turnText(peer.turns[0]!)
    expect(text).toContain('Subject: ping')
    // Direct mail names who to reply as.
    expect(text).toContain(`--from orca_session_id:${PEER_CHAT}`)
    await settleTurn(PEER_CHAT, 0)
    await vi.waitFor(() => expect(unread(`orca_session_id:${PEER_CHAT}`)).toEqual([]), WAIT)
  })

  it('refuses mail to a chat that was closed, before storing it', async () => {
    await openChat(PEER_CHAT)
    await host.setSessionTabVisibility(PEER_CHAT, false)
    const response = await dispatcher.dispatch(
      request('orchestration.send', {
        from: 'term_worker',
        to: `orca_session_id:${PEER_CHAT}`,
        subject: 'ping'
      })
    )
    expect(response).toMatchObject({ ok: false, error: { code: 'session_caller_not_live' } })
    expect(db.getInbox(100)).toEqual([])
  })
})
