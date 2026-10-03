// A worker's result reaching the structured chat that coordinates it, end to end in one process.
//
// Real: the structured agent-session host, its record store, journal, lease and Codex adapter; the
// orchestration database, RPC dispatcher and methods; the runtime's pointer lanes. Fake: only the
// Codex app-server child, which answers the JSON-RPC calls the real one does.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../shared/protocol-version'
import {
  AgentSessionAcquisitionRefusal,
  AgentSessionPreSpawnError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS } from '../../shared/agent-session-host-authority'
import { refuse } from '../../shared/agent-session-wire-refusals'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { localOrchestrationCliCommand } from './orchestration/cli-command'
import { formatMessagePointer } from './orchestration/formatter'
import { currentRunCoordinatorOrcaSessionId } from './orchestration/db/runs/run-coordinator-orca-session'
import type { RpcRequest } from './rpc/core'
import { RpcDispatcher } from './rpc/dispatcher'
import { ORCHESTRATION_METHODS } from './rpc/methods/orchestration'
import { idOf, isRecord, resultOf } from './rpc/orchestration-session-caller-test-fixture'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { createCoordinatorMailObservationClock } from './structured-chat-coordinator-observation-clock.test-fixture'
import {
  attachParams,
  fakeCodex,
  operationId,
  providerFaults,
  resetProviderFaults,
  type FakeConnection
} from './structured-chat-coordinator-fake-codex-fixture'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

const COORDINATOR = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
const PEER_CHAT = '7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64'
const WORKER_PANE = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const WORKER_2_PANE = 'tab_worker2:cccccccc-cccc-4ccc-8ccc-cccccccccccc'

let codex: ReturnType<typeof fakeCodex>
let root: string
let runtime: OrcaRuntimeService
let db: OrchestrationDb
let host: StructuredAgentSessionHost
let dispatcher: RpcDispatcher
let requests = 0
const observationClock = createCoordinatorMailObservationClock(() => host, COORDINATOR)

function request(
  method: string,
  params: Record<string, unknown>,
  options: { sessionId?: string } = {}
): RpcRequest {
  requests += 1
  return {
    id: `rpc-${requests}`,
    authToken: 'test',
    method,
    params,
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: `req-${requests}`,
    ...(options.sessionId
      ? { orchestrationCompatibilityEvidence: { agentSessionId: options.sessionId } }
      : {})
  }
}

async function call(
  method: string,
  params: Record<string, unknown>,
  options?: { sessionId?: string }
): Promise<Record<string, unknown>> {
  const response = await dispatcher.dispatch(request(method, params, options))
  if (!response.ok) {
    throw new Error(`${method} failed: ${JSON.stringify(response)}`)
  }
  return resultOf(response)
}

async function openChat(sessionId: string): Promise<FakeConnection> {
  const attached = await host.attach({ callerKey: 'test-surface' }, attachParams(sessionId))
  expect(attached, JSON.stringify(attached)).toMatchObject({ ok: true })
  await host.setSessionTabVisibility(sessionId, true)
  threadBySession.set(sessionId, codex.connections.at(-1)!.threadId!)
  return connectionFor(sessionId)
}

const threadBySession = new Map<string, string>()

function connectionFor(sessionId: string): FakeConnection {
  // A cleared chat's successor starts on its first message; its record then names its thread.
  const head = agentSessionProviderHandleChainHead(
    host.deps.store.getRecord(sessionId)?.providerHandleChain ?? []
  )
  const thread =
    threadBySession.get(sessionId) ?? (head?.handle.provider === 'codex' && head.handle.threadId)
  const connection = codex.connections.findLast((candidate) => candidate.threadId === thread)
  if (!connection) {
    throw new Error(`no app-server for ${sessionId}`)
  }
  return connection
}

/** Codex's own sequence for a turn: it starts, echoes the user message, and completes. */
async function settleTurn(sessionId: string, turnIndex: number): Promise<void> {
  const connection = connectionFor(sessionId)
  const turn = connection.turns[turnIndex]!
  const turnId = `turn-${turnIndex + 1}`
  const notify = (method: string, params: unknown) =>
    connection.handlers.onNotification?.(method, params)
  notify('turn/started', { turn: { id: turnId } })
  notify('item/completed', {
    item: {
      type: 'userMessage',
      id: `echo-${turn.clientUserMessageId}`,
      clientId: turn.clientUserMessageId,
      content: [{ type: 'text', text: 'pointer' }]
    }
  })
  notify('turn/completed', { turn: { id: turnId } })
  await host.flushStreamedEvents(sessionId)
}

/** A user message typed into the chat, as the chat surface sends it. */
function sendUserMessage(sessionId: string, text: string) {
  const body = {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text }]
  }
  return host.send(
    { callerKey: 'test-surface' },
    {
      envelope: {
        sessionId,
        clientOperationId: operationId(),
        expectedRuntimeFence: host.deps.store.getRecord(sessionId)!.lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId,
          fields: { body }
        })
      },
      body
    }
  )
}

async function userTexts(sessionId: string): Promise<string[]> {
  return (await host.journalSnapshot(sessionId)).items.flatMap((item: AgentJournalRenderItem) =>
    item.body?.kind === 'message' && item.body.role === 'user'
      ? item.body.blocks.map((block) => (block.type === 'text' ? block.text : ''))
      : []
  )
}

/** A supervised terminal worker under the coordinator's Run, and its worker_done. */
async function finishWorker(
  taskId: string,
  worker: { handle: string; paneKey: string } = { handle: 'term_worker', paneKey: WORKER_PANE }
): Promise<void> {
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId,
    startOptions: {}
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: worker.handle,
    paneKey: worker.paneKey,
    processIncarnation: `runtime_test:${worker.handle}:1`,
    worktreeId: 'repo::worker',
    effects: [],
    setupState: 'not_applicable'
  })
  db.markWorkerDispatchReady(started.dispatch.id)
  await call('orchestration.send', {
    from: worker.handle,
    subject: 'Done',
    type: 'worker_done',
    payload: JSON.stringify({ taskId, dispatchId: started.dispatch.id, outcome: 'succeeded' })
  })
}

async function coordinatorRunAndTask(): Promise<{ runId: string; taskId: string }> {
  const created = await call(
    'orchestration.runCreate',
    { objective: 'ship' },
    {
      sessionId: COORDINATOR
    }
  )
  const runId = idOf(created.run)
  const task = await call(
    'orchestration.taskCreate',
    { spec: 'build it' },
    {
      sessionId: COORDINATOR
    }
  )
  return { runId, taskId: idOf(task.task) }
}

/** `/clear` as the chat surface runs it: the conversation continues in a new session. */
async function clearChat(sessionId: string): Promise<string> {
  const command = 'clear' as const
  const cleared = await host.conversationCommand(
    { callerKey: 'test-surface' },
    {
      command,
      envelope: {
        sessionId,
        clientOperationId: operationId(),
        expectedRuntimeFence: host.deps.store.getRecord(sessionId)!.lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.conversationCommand',
          sessionId,
          fields: { command }
        })
      }
    }
  )
  const successor = cleared.ok ? cleared.value.replacementSessionId : undefined
  if (!successor) {
    throw new Error(`clear failed: ${JSON.stringify(cleared)}`)
  }
  // The surface swaps the tab over to the session that continues the chat.
  await host.setSessionTabVisibility(sessionId, false)
  await host.setSessionTabVisibility(successor, true)
  return successor
}

/** A cleared chat's successor runs once the user writes to it; only then can its agent act. */
async function startSuccessor(successor: string): Promise<void> {
  expect(await sendUserMessage(successor, 'hello')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(connectionFor(successor).turns).toHaveLength(1), WAIT)
  await settleTurn(successor, 0)
}

beforeEach(async () => {
  resetProviderFaults()
  root = await mkdtemp(join(tmpdir(), 'orca-structured-coordinator-mail-'))
  codex = fakeCodex()
  db = new OrchestrationDb(':memory:')
  runtime = startRuntime()
  host = await ensureStructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async (workspaceId) => `/repos/${workspaceId}`,
    resolveCodexCommand: () => '/usr/local/bin/codex',
    resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true }),
    resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
    openCodexConnection: codex.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    // The same call the runtime's own host install makes on every status change.
    onSessionStatusChanged: (summary) => runtime.onStructuredSessionStatusForMail(summary)
  })
  dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
})

/** The runtime over the shared database; a second call is what an Orca restart leaves behind. */
function startRuntime(): OrcaRuntimeService {
  const started = new OrcaRuntimeService()
  started.setOrchestrationDb(db)
  vi.spyOn(started, 'ensureStructuredAgentSessionHost').mockResolvedValue()
  vi.spyOn(started, 'getTerminalPaneKey').mockImplementation((handle) =>
    handle === 'term_worker' ? WORKER_PANE : handle === 'term_worker_2' ? WORKER_2_PANE : null
  )
  return started
}

afterEach(async () => {
  try {
    await stopStructuredAgentSessionRuntime()
    db.close()
    await observationClock.drainClosedDatabaseRepair()
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  } finally {
    observationClock.restore()
  }
})

// Pointers are sent on asynchronous edges; the default 1s wait is too tight under a loaded parallel run.
const WAIT = { timeout: 10_000 }

const POINTER =
  /You have 1 orchestration message\. Run `orca(-dev)? orchestration check --run run_\w+`\./

/** The text the PTY lane types into a local terminal for this mailbox, byte for byte. */
function ptyPointer(mailboxHandle: string): string {
  return formatMessagePointer(1, mailboxHandle, localOrchestrationCliCommand()).trim()
}

/** The text of a turn the fake provider received. */
function turnText(turn: { text: string }): string {
  const input: unknown = JSON.parse(turn.text)
  return Array.isArray(input)
    ? input.map((item: unknown) => (isRecord(item) ? String(item.text) : '')).join('')
    : ''
}

describe('a worker result reaches the structured chat that coordinates it', () => {
  it('lands as a turn in the coordinator journal, and a flagless check returns the worker_done', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()

    await finishWorker(taskId)

    // No user action: the result itself sends the chat a turn through the host's send.
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    expect(turnText(chat.turns[0]!)).toBe(ptyPointer(`run:${runId}`))
    await settleTurn(COORDINATOR, 0)
    expect(await userTexts(COORDINATOR)).toEqual([expect.stringMatching(POINTER)])

    const checked = await call('orchestration.check', {}, { sessionId: COORDINATOR })
    expect(checked).toMatchObject({
      runId,
      count: 1,
      messages: [{ type: 'worker_done', from_handle: 'term_worker' }]
    })
  })

  it('does not send a second pointer when the delivery is retried', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    await finishWorker(taskId)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)

    // A pending send is not an acknowledgement, so the mail is retained and retried on every edge
    // until the host confirms it: before the echo, and again at the turn's idle edge.
    runtime.deliverPendingMessagesForHandle(`run:${runId}`)
    await settleTurn(COORDINATOR, 0)
    runtime.deliverPendingMessagesForHandle(`run:${runId}`)
    await vi.waitFor(
      () => expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toEqual([]),
      WAIT
    )
    expect(chat.turns).toHaveLength(1)
    expect(await userTexts(COORDINATOR)).toHaveLength(1)
  })

  /** Fires both edges and waits until every gate read they started has answered. */
  const edgesAnswered = (): Promise<void> => observationClock.edgesAnswered(runtime, WAIT)

  /** The operation ids the coordinator's journal recorded for its pointer turns. */
  async function pointerSends(): Promise<string[]> {
    const snapshot = await host.journalSnapshot(COORDINATOR)
    return snapshot.submissions
      .filter((submission) =>
        snapshot.items.some(
          (item) =>
            item.itemId === agentJournalSubmissionKey(submission.clientMessageId) &&
            item.body?.kind === 'message' &&
            item.body.blocks.some((block) => block.type === 'text' && POINTER.test(block.text))
        )
      )
      .map((submission) => submission.clientMessageId)
  }

  it('keeps a pointer whose provider died before the echo, and points it after the next turn that runs', async () => {
    // A provider that dies before echoing never ran the pointer: the mail stays unpointed, and
    // neither the death's own edge nor an idle one starts the provider again for it.
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    await finishWorker(taskId)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)

    chat.handlers.onExit?.(new Error('provider died before the echo'))
    const before = codex.connections.length
    await edgesAnswered()
    await edgesAnswered()
    expect(codex.connections.length).toBe(before)
    expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toHaveLength(1)

    // The user's next message starts the agent; once its turn runs, the pointer follows it.
    expect(await sendUserMessage(COORDINATOR, 'again')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(codex.connections.length).toBe(before + 1), WAIT)
    const revived = connectionFor(COORDINATOR)
    await vi.waitFor(() => expect(revived.turns).toHaveLength(1), WAIT)
    expect(revived.turns[0]!.text).toContain('again')
    await settleTurn(COORDINATOR, 0)
    await vi.waitFor(() => expect(revived.turns).toHaveLength(2), WAIT)
    expect(revived.turns[1]!.text).toMatch(POINTER)
    await settleTurn(COORDINATOR, 1)
    await vi.waitFor(
      () => expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toEqual([]),
      WAIT
    )
  })

  it('does not restart a provider that dies before every echo, however many edges follow', async () => {
    observationClock.start()
    // What this pins: each death's own status edge used to re-point the mail, and that send started
    // the provider again, about once a second for as long as the mail was unread.
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
    expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toHaveLength(1)
  })

  it.each(['exit-then-throw', 'throw-then-exit'] as const)(
    'does not restart a provider that crashed while taking the pointer turn (%s)',
    async (crash) => {
      observationClock.start()
      // The crash settles the send `unknown` with the connection's own error, not as a provider
      // exit; every status edge after it re-pointed the mail and started the provider again.
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
      expect(await pointerSends()).toHaveLength(1)
      expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toHaveLength(1)
    }
  )

  it('points the next result once after a transient death, then holds nothing', async () => {
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
    // The death was transient. A new result is new mail: one pointer for both, one start.
    providerFaults.dieBeforeEveryEcho = false
    const before = providerFaults.starts
    await finishWorker(idOf(second.task), { handle: 'term_worker_2', paneKey: WORKER_2_PANE })
    await vi.waitFor(() => expect(providerFaults.turnStarts).toBe(2), WAIT)
    const revived = connectionFor(COORDINATOR)
    expect(turnText(revived.turns.at(-1)!)).toBe(
      formatMessagePointer(2, `run:${runId}`, localOrchestrationCliCommand()).trim()
    )
    await settleTurn(COORDINATOR, revived.turns.length - 1)
    await vi.waitFor(
      () => expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toEqual([]),
      WAIT
    )
    expect(providerFaults.starts - before).toBe(1)
    expect(providerFaults.turnStarts).toBe(2)
  })

  it('leaves a pointer the person stopped while its agent was starting stopped', async () => {
    await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    await host.close(COORDINATOR, 'evict')
    providerFaults.startDelayMs = 400
    const before = providerFaults.starts
    await finishWorker(taskId)
    await vi.waitFor(() => expect(providerFaults.starts).toBe(before + 1), WAIT)
    // The person presses Stop while the agent is still starting.
    const cancelled = await host.cancel(
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
    expect(cancelled).toMatchObject({ ok: true })
    providerFaults.startDelayMs = 0
    // A fixed window, not a poll: a re-point would start the agent again in it.
    await observationClock.observe(1_500)
    expect(providerFaults.starts - before).toBe(1)
    expect(await pointerSends()).toHaveLength(1)
    await edgesAnswered()
    expect(providerFaults.starts - before).toBe(1)
    expect(providerFaults.turnStarts).toBe(0)
    expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toHaveLength(1)
  })

  it('points a held pointer once more after Orca restarts, under a new id', async () => {
    observationClock.start()
    await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    providerFaults.dieBeforeEveryEcho = true
    await finishWorker(taskId)
    await vi.waitFor(() => expect(providerFaults.turnStarts).toBe(1), WAIT)
    await edgesAnswered()
    const [held] = await pointerSends()

    // The next process: a fresh runtime over the same database redrives restored mail. The
    // provider still dies, so exactly one start proves it is pointed once, not in a loop.
    runtime = startRuntime()
    dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const before = providerFaults.starts
    await vi.waitFor(() => expect(providerFaults.turnStarts).toBe(2), WAIT)
    await observationClock.observe(1_500)
    await edgesAnswered()
    expect(providerFaults.starts - before).toBe(1)
    expect(providerFaults.turnStarts).toBe(2)
    const sends = await pointerSends()
    expect(sends).toHaveLength(2)
    expect(sends[0]).toBe(held)
    expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toHaveLength(1)
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
    await vi.waitFor(
      () => expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toHaveLength(1),
      WAIT
    )
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
    'holds mail after a start refused as %s until a turn runs, adding nothing on later edges',
    async (_label, refusal) => {
      const { runId, starts } = await refusedStartsFor(refusal)
      expect(starts).toBe(1)
      // Later edges replay the refusal: no start, and no new pointer and failure rows in the chat.
      const before = providerFaults.starts
      for (let edge = 0; edge < 5; edge += 1) {
        runtime.onStructuredSessionStatusForMail({ sessionId: COORDINATOR, status: 'idle' })
        await observationClock.observe(100)
      }
      await edgesAnswered()
      expect(providerFaults.starts).toBe(before)
      expect(await pointerSends()).toHaveLength(1)
      expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toHaveLength(1)

      // Fixed, the person's next message starts the agent, and the pointer follows its turn.
      providerFaults.refuseStart = null
      expect(await sendUserMessage(COORDINATOR, 'again')).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(providerFaults.starts).toBe(before + 1), WAIT)
      const revived = connectionFor(COORDINATOR)
      await vi.waitFor(() => expect(revived.turns.length).toBeGreaterThanOrEqual(1), WAIT)
      expect(revived.turns[0]!.text).toContain('again')
      await settleTurn(COORDINATOR, 0)
      await vi.waitFor(() => expect(revived.turns).toHaveLength(2), WAIT)
      expect(revived.turns[1]!.text).toMatch(POINTER)
    }
  )

  it('points held mail after the next turn that runs, even once a rewind dropped its send', async () => {
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
    expect(await pointerSends()).toEqual([])

    providerFaults.crashOnTurnStart = 'off'
    expect(await sendUserMessage(COORDINATOR, 'again')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(providerFaults.turnStarts).toBe(2), WAIT)
    const revived = connectionFor(COORDINATOR)
    expect(revived).not.toBe(chat)
    await settleTurn(COORDINATOR, revived.turns.length - 1)
    await vi.waitFor(() => expect(turnText(revived.turns.at(-1)!)).toMatch(POINTER), WAIT)
    await settleTurn(COORDINATOR, revived.turns.length - 1)
    await vi.waitFor(
      () => expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toEqual([]),
      WAIT
    )
  })

  it('points again under a new id once a send the host never recorded is too old to admit', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    // The first pointer is refused before the host records it, so the journal holds no verdict.
    const realSend = host.send
    const refused = vi.spyOn(host, 'send').mockImplementationOnce(async () => ({
      ok: false as const,
      refusal: refuse(
        'agent_session_operation_invalid',
        { reason: 'conversationCommandInFlight' },
        'busy'
      )
    }))
    refused.mockImplementation((caller, params) => realSend(caller, params))
    await finishWorker(taskId)
    await vi.waitFor(() => expect(refused).toHaveBeenCalledTimes(1), WAIT)
    const held = db.getStructuredPointerOperation(`run:${runId}`)?.operation_id

    // No edge for a day: the host would now refuse that id as expired, on every retry.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS + 60_000)
      await edgesAnswered()
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(chat.turns.map(turnText)).toEqual([ptyPointer(`run:${runId}`)])
      expect(db.getStructuredPointerOperation(`run:${runId}`)?.operation_id).not.toBe(held)
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds mail a refused turn left in doubt until the next result, then points it once', async () => {
    // A failed turn/start cannot prove the turn never started, so the host records it `unknown`
    // and a resend under its id replays that; new mail is a new send.
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const second = await call(
      'orchestration.taskCreate',
      { spec: 'more' },
      { sessionId: COORDINATOR }
    )
    providerFaults.refuseTurnStarts = 1
    const before = codex.connections.length
    await finishWorker(taskId)
    await vi.waitFor(() => expect(providerFaults.turnStarts).toBe(1), WAIT)
    await edgesAnswered()
    expect(chat.turns).toHaveLength(0)

    await finishWorker(idOf(second.task), { handle: 'term_worker_2', paneKey: WORKER_2_PANE })
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    expect(turnText(chat.turns[0]!)).toBe(
      formatMessagePointer(2, `run:${runId}`, localOrchestrationCliCommand()).trim()
    )
    expect(codex.connections.length).toBe(before)
  })

  it('points a coordinator whose agent is not running through the send alone, which starts it', async () => {
    await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    // What the idle sweep leaves of a chat nobody is looking at: agent stopped, no map entry.
    await host.close(COORDINATOR, 'evict')
    expect(host.hasSession(COORDINATOR)).toBe(false)
    const before = codex.connections.length

    await finishWorker(taskId)

    // Nothing holds or wakes the session first: the pointer's accepted send starts its agent.
    await vi.waitFor(() => expect(codex.connections.length).toBe(before + 1), WAIT)
    const revived = connectionFor(COORDINATOR)
    await vi.waitFor(() => expect(revived.turns).toHaveLength(1), WAIT)
    expect(revived.turns[0]!.text).toMatch(POINTER)
    await settleTurn(COORDINATOR, 0)
    expect(await userTexts(COORDINATOR)).toEqual([expect.stringMatching(POINTER)])
  })

  it('points mail at the idle edge when it arrived mid-turn', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const first = await host.send(
      { callerKey: 'test-surface' },
      {
        envelope: {
          sessionId: COORDINATOR,
          clientOperationId: operationId(),
          expectedRuntimeFence: host.deps.store.getRecord(COORDINATOR)!.lease.runtimeFence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: COORDINATOR,
            fields: {
              body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] }
            }
          })
        },
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] }
      }
    )
    expect(first).toMatchObject({ ok: true })
    // Accepted, then delivered: the provider sees the turn once the host hands it over.
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
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The coordinator is mid-turn, so nothing is folded into that turn.
    expect(chat.turns).toHaveLength(1)

    notify('turn/completed', { turn: { id: 'turn-1' } })
    await host.flushStreamedEvents(COORDINATOR)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    expect(chat.turns[1]!.text).toMatch(POINTER)
    expect(chat.turns[1]!.text).toContain(runId)
  })
})

describe('a /clear keeps the chat its orchestration address', () => {
  it("delivers the conversation's Run to the session that continues it, and acts as it", async () => {
    await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const generation = db.getRunRaw(runId)!.consumer_generation
    const successor = await clearChat(COORDINATOR)
    const opened = codex.connections.length

    // The worker's result is the successor's first message, which starts it on a new thread.
    await finishWorker(taskId)
    await vi.waitFor(() => expect(connectionFor(successor).turns).toHaveLength(1), WAIT)
    const next = connectionFor(successor)
    expect(codex.connections.slice(opened)).toEqual([next])
    expect(next.methods.filter((method) => method.startsWith('thread/'))).toEqual(['thread/start'])
    expect(next.turns[0]!.text).toMatch(POINTER)
    await settleTurn(successor, 0)
    await expect(
      call('orchestration.runCurrent', {}, { sessionId: successor })
    ).resolves.toMatchObject({ run: { id: runId } })
    await expect(call('orchestration.check', {}, { sessionId: successor })).resolves.toMatchObject({
      runId,
      count: 1,
      messages: [{ type: 'worker_done' }]
    })
    // Nothing was rewritten: the Run is bound exactly as the first session bound it.
    expect(db.getRunRaw(runId)).toMatchObject({
      coordinator_orca_session_id: COORDINATOR,
      consumer_generation: generation
    })
  })

  it('points mail the cleared chat never took at the successor, with no message from the user', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    await finishWorker(taskId)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    // The provider dies before it runs the pointer, so the mail is still unpointed at the /clear.
    chat.handlers.onExit?.(new Error('provider died before the echo'))
    await vi.waitFor(() =>
      expect(host.deps.store.getRecord(COORDINATOR)?.lease.claimStatus).toBe('released')
    )
    expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toHaveLength(1)

    const successor = await clearChat(COORDINATOR)
    await vi.waitFor(() => expect(connectionFor(successor).turns[0]?.text).toMatch(POINTER), WAIT)
    await settleTurn(successor, 0)
    await vi.waitFor(
      () => expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toEqual([]),
      WAIT
    )
  })

  it("stores the successor's own Run under the conversation's address, through a chain of clears", async () => {
    await openChat(COORDINATOR)
    const middle = await clearChat(COORDINATOR)
    await startSuccessor(middle)
    const created = await call(
      'orchestration.runCreate',
      { objective: 'next' },
      { sessionId: middle }
    )
    const runId = idOf(created.run)
    expect(db.getRunRaw(runId)!.coordinator_orca_session_id).toBe(COORDINATOR)
    const successor = await clearChat(middle)
    await startSuccessor(successor)

    await expect(
      call('orchestration.runCurrent', {}, { sessionId: successor })
    ).resolves.toMatchObject({ run: { id: runId } })
    expect(db.getRunRaw(runId)!.coordinator_orca_session_id).toBe(COORDINATOR)
    // What it sends carries the same address.
    await openChat(PEER_CHAT)
    await expect(
      call(
        'orchestration.send',
        { to: `orca_session_id:${PEER_CHAT}`, subject: 'hi' },
        { sessionId: successor }
      )
    ).resolves.toMatchObject({ message: { from_handle: `orca_session_id:${COORDINATOR}` } })
  })

  it("binds a Run a cleared chat creates or uses to the conversation's root, at the Run's current generation", async () => {
    const root = COORDINATOR
    const boundOrcaSessionId = (runId: string): string | null =>
      currentRunCoordinatorOrcaSessionId(db.getRunRaw(runId)!)
    await openChat(COORDINATOR)
    const middle = await clearChat(COORDINATOR)
    await startSuccessor(middle)
    const first = idOf(
      (await call('orchestration.runCreate', { objective: 'first' }, { sessionId: middle })).run
    )
    expect(db.getRunRaw(first)).toMatchObject({
      coordinator_orca_session_id: root,
      coordinator_orca_session_id_generation: db.getRunRaw(first)!.consumer_generation
    })
    expect(boundOrcaSessionId(first)).toBe(root)
    const second = idOf(
      (await call('orchestration.runCreate', { objective: 'second' }, { sessionId: middle })).run
    )
    expect(boundOrcaSessionId(first)).toBeNull()

    const successor = await clearChat(middle)
    await startSuccessor(successor)
    await call('orchestration.runUse', { id: first }, { sessionId: successor })
    const rebound = db.getRunRaw(first)!
    expect(rebound.coordinator_orca_session_id).toBe(root)
    expect(rebound.coordinator_orca_session_id_generation).toBe(rebound.consumer_generation)
    expect(boundOrcaSessionId(second)).toBeNull()
    await expect(
      call('orchestration.runCurrent', {}, { sessionId: successor })
    ).resolves.toMatchObject({ run: { id: first } })
  })

  it('lands mail sent to any session of the conversation in the live one', async () => {
    await openChat(PEER_CHAT)
    const middle = await clearChat(PEER_CHAT)
    const successor = await clearChat(middle)
    // The first ping starts the live session, which neither clear did.
    for (const [index, spelling] of [PEER_CHAT, middle, successor].entries()) {
      const sent = await call('orchestration.send', {
        from: 'term_worker',
        to: `orca_session_id:${spelling}`,
        subject: `ping ${index}`
      })
      expect(sent).toMatchObject({ message: { to_handle: `orca_session_id:${PEER_CHAT}` } })
      await vi.waitFor(() => expect(connectionFor(successor).turns).toHaveLength(index + 1), WAIT)
      await settleTurn(successor, index)
    }
    await expect(call('orchestration.check', {}, { sessionId: successor })).resolves.toMatchObject({
      count: 3
    })
  })
})

describe('any live session is addressable by its id', () => {
  it('lands mail sent to `orca_session_id:<id>` as a turn in that chat, which a flagless check reads', async () => {
    const peer = await openChat(PEER_CHAT)

    const sent = await call('orchestration.send', {
      from: 'term_worker',
      to: `orca_session_id:${PEER_CHAT}`,
      subject: 'ping'
    })
    expect(sent).toMatchObject({ message: { to_handle: `orca_session_id:${PEER_CHAT}` } })

    await vi.waitFor(() => expect(peer.turns).toHaveLength(1), WAIT)
    // Direct mail is not in a Run, so the pointer names no `--run`.
    expect(turnText(peer.turns[0]!)).toBe(ptyPointer(`orca_session_id:${PEER_CHAT}`))
    await settleTurn(PEER_CHAT, 0)
    const checked = await call('orchestration.check', {}, { sessionId: PEER_CHAT })
    expect(checked).toMatchObject({ count: 1, messages: [{ subject: 'ping' }] })
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
