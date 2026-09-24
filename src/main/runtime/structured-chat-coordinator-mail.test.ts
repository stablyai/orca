// A worker's result reaching the structured chat that coordinates it, end to end in one process.
//
// Real: the structured agent-session host, its record store, journal, lease and Codex adapter; the
// orchestration database, RPC dispatcher and methods; the runtime's pointer lanes. Fake: only the
// Codex app-server child, which answers the JSON-RPC calls the real one does.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  openCodexAppServerConnection
} from '../codex/codex-app-server-connection'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../shared/protocol-version'
import { attachFingerprintFields } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import type { RpcRequest } from './rpc/core'
import { RpcDispatcher } from './rpc/dispatcher'
import { ORCHESTRATION_METHODS } from './rpc/methods/orchestration'
import { idOf, isRecord, resultOf } from './rpc/orchestration-session-caller-test-fixture'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

const COORDINATOR = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
const PEER_CHAT = '7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64'
const WORKSPACE = 'workspace-1'
const WORKER_PANE = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const WORKER_2_PANE = 'tab_worker2:cccccccc-cccc-4ccc-8ccc-cccccccccccc'

type FakeConnection = Omit<CodexAppServerConnection, 'closed'> & {
  closed: boolean
  handlers: CodexAppServerConnectionHandlers
  threadId: string | null
  turns: { clientUserMessageId: string; text: string }[]
}

function fakeCodex() {
  const connections: FakeConnection[] = []
  let turnCounter = 0
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a fake answering the JSON-RPC calls the adapter makes, as the shipped integration test does.
  const openConnection = (async (_launch, handlers = {}) => {
    const connection: FakeConnection = {
      handlers,
      threadId: null,
      turns: [],
      pid: 4321,
      closed: false,
      request: async (method, params) => {
        const input = isRecord(params) ? params : {}
        if (method === 'thread/start') {
          connection.threadId = `thread-${connections.length}`
          return { thread: { id: connection.threadId } }
        }
        if (method === 'thread/resume') {
          connection.threadId = String(input.threadId)
          return { thread: { id: connection.threadId } }
        }
        if (method === 'turn/start') {
          turnCounter += 1
          connection.turns.push({
            clientUserMessageId: String(input.clientUserMessageId),
            text: JSON.stringify(input.input)
          })
          return { turn: { id: `turn-${turnCounter}` } }
        }
        if (method === 'model/list') {
          return {
            data: [
              {
                model: 'gpt-live',
                displayName: 'GPT Live',
                hidden: false,
                supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
                defaultReasoningEffort: 'medium',
                isDefault: true
              }
            ],
            nextCursor: null
          }
        }
        return {}
      },
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => {
        connection.closed = true
        return true
      }
    }
    connections.push(connection)
    return connection
  }) as typeof openCodexAppServerConnection
  return { connections, openConnection }
}

let operations = 0
function operationId(): string {
  operations += 1
  return `${Date.now()}-${operations.toString(16).padStart(32, '0')}`
}

function attachParams(sessionId: string) {
  const params = {
    location: {
      executionHostId: 'local' as const,
      wslDistro: null,
      workspaceId: WORKSPACE,
      workspaceKind: 'git-worktree' as const
    },
    provider: 'codex' as const,
    agent: 'codex' as const,
    accountHome: { variable: 'CODEX_HOME' as const, path: '/home/dev/.codex' },
    runtimeKind: 'native' as const
  }
  const envelope = {
    sessionId,
    clientOperationId: operationId(),
    expectedRuntimeFence: null,
    payloadFingerprint: ''
  }
  return {
    ...params,
    envelope: {
      ...envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.attach',
        sessionId,
        fields: attachFingerprintFields({ ...params, envelope })
      })
    }
  }
}

let codex: ReturnType<typeof fakeCodex>
let root: string
let runtime: OrcaRuntimeService
let db: OrchestrationDb
let host: StructuredAgentSessionHost
let dispatcher: RpcDispatcher
let requests = 0

function request(
  method: string,
  params: Record<string, unknown>,
  options: { sessionId?: string; capability?: string } = {}
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
      : {}),
    ...(options.capability ? { orchestrationCapability: options.capability } : {})
  }
}

async function call(
  method: string,
  params: Record<string, unknown>,
  options?: { sessionId?: string; capability?: string }
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
  const connection = codex.connections.findLast(
    (candidate) => candidate.threadId === threadBySession.get(sessionId)
  )
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

function userTexts(sessionId: string): string[] {
  return host
    .journalSnapshot(sessionId)
    .items.flatMap((item: AgentJournalRenderItem) =>
      item.body?.kind === 'message' && item.body.role === 'user'
        ? item.body.blocks.map((block) => (block.type === 'text' ? block.text : ''))
        : []
    )
}

/** A capability-backed terminal worker under the coordinator's Run, and its worker_done. */
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
  const capability = db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: worker.handle,
    paneKey: worker.paneKey,
    processIncarnation: `runtime_test:${worker.handle}:1`,
    worktreeId: 'repo::worker',
    effects: [],
    setupState: 'not_applicable'
  })
  db.markWorkerDispatchReady(started.dispatch.id)
  await call(
    'orchestration.send',
    {
      from: worker.handle,
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId, dispatchId: started.dispatch.id, outcome: 'succeeded' })
    },
    { capability }
  )
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
  threadBySession.set(successor, codex.connections.at(-1)!.threadId!)
  return successor
}

beforeEach(async () => {
  operations = 0
  root = await mkdtemp(join(tmpdir(), 'orca-structured-coordinator-mail-'))
  codex = fakeCodex()
  db = new OrchestrationDb(':memory:')
  runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue()
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
    handle === 'term_worker' ? WORKER_PANE : handle === 'term_worker_2' ? WORKER_2_PANE : null
  )
  host = await ensureStructuredAgentSessionHost({
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

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  db.close()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

// The session's own CLI by its env var: a bare `orca` can resolve elsewhere in a login shell.
// Pointers are sent on asynchronous edges; the default 1s wait is too tight under a loaded parallel run.
const WAIT = { timeout: 10_000 }

const POINTER =
  /You have 1 orchestration message\. Run `\\?"\$ORCA_CLI_COMMAND\\?" orchestration check --run run_/

describe('a worker result reaches the structured chat that coordinates it', () => {
  it('lands as a turn in the coordinator journal, and a flagless check returns the worker_done', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()

    await finishWorker(taskId)

    // No user action: the result itself sends the chat a turn through the host's send.
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    expect(chat.turns[0]!.text).toMatch(POINTER)
    expect(chat.turns[0]!.text).toContain(runId)
    await settleTurn(COORDINATOR, 0)
    expect(userTexts(COORDINATOR)).toEqual([expect.stringMatching(POINTER)])

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
    expect(userTexts(COORDINATOR)).toHaveLength(1)
  })

  it('points the next result at a coordinator that read the last one without acking', async () => {
    // The strand this pins: a flagless `check` opens a delivery that `check` replays until acked,
    // and a lane gated on "an unacknowledged batch exists" never pointed the chat at a later result.
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    await finishWorker(taskId)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    await settleTurn(COORDINATOR, 0)
    const first = await call('orchestration.check', {}, { sessionId: COORDINATOR })
    const heldDelivery = String(first.deliveryId)
    expect(first).toMatchObject({ count: 1, messages: [{ type: 'worker_done' }] })

    const second = await call(
      'orchestration.taskCreate',
      { spec: 'more' },
      { sessionId: COORDINATOR }
    )
    await finishWorker(idOf(second.task), { handle: 'term_worker_2', paneKey: WORKER_2_PANE })
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    expect(chat.turns[1]!.text).toContain('1 new orchestration message')
    expect(chat.turns[1]!.text).toContain(`--ack ${heldDelivery}`)
    await settleTurn(COORDINATOR, 1)

    // Exactly once per new message: a retry and the idle edge point nothing further.
    runtime.deliverPendingMessagesForHandle(`run:${runId}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(chat.turns).toHaveLength(2)

    const acked = await call(
      'orchestration.check',
      { ack: heldDelivery },
      { sessionId: COORDINATOR }
    )
    expect(acked).toMatchObject({ acknowledged: heldDelivery, count: 1 })
    expect(acked.messages).not.toEqual(first.messages)
  })

  it('gives back a pointer whose provider died before the echo, and points it again', async () => {
    // Admitted is not a turn: a provider that dies before echoing never ran the pointer, and a row
    // left stamped "pointed" would never be pointed again — the last result would strand silently.
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    await finishWorker(taskId)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    await vi.waitFor(
      () => expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toEqual([]),
      WAIT
    )

    chat.handlers.onExit?.(new Error('provider died before the echo'))
    await vi.waitFor(
      () => expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toHaveLength(1),
      WAIT
    )

    const before = codex.connections.length
    runtime.onStructuredSessionStatusForMail({ sessionId: COORDINATOR, status: 'idle' })
    await vi.waitFor(() => expect(codex.connections.length).toBe(before + 1), WAIT)
    const revived = connectionFor(COORDINATOR)
    await vi.waitFor(() => expect(revived.turns).toHaveLength(1), WAIT)
    expect(revived.turns[0]!.text).toMatch(POINTER)
  })

  it('wakes a coordinator the host evicted, and delivers once it is back', async () => {
    await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    // What the release clock does to a chat nobody is looking at: child stopped, lease released.
    await host.close(COORDINATOR)
    expect(host.hasSession(COORDINATOR)).toBe(false)
    const before = codex.connections.length

    await finishWorker(taskId)

    await vi.waitFor(() => expect(codex.connections.length).toBe(before + 1), WAIT)
    const revived = connectionFor(COORDINATOR)
    await vi.waitFor(() => expect(revived.turns).toHaveLength(1), WAIT)
    expect(revived.turns[0]!.text).toMatch(POINTER)
    await settleTurn(COORDINATOR, 0)
    expect(userTexts(COORDINATOR)).toEqual([expect.stringMatching(POINTER)])
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
    const next = connectionFor(successor)

    await expect(
      call('orchestration.runCurrent', {}, { sessionId: successor })
    ).resolves.toMatchObject({ run: { id: runId } })
    await finishWorker(taskId)
    await vi.waitFor(() => expect(next.turns).toHaveLength(1), WAIT)
    expect(next.turns[0]!.text).toMatch(POINTER)
    await settleTurn(successor, 0)
    await expect(call('orchestration.check', {}, { sessionId: successor })).resolves.toMatchObject({
      runId,
      count: 1,
      messages: [{ type: 'worker_done' }]
    })
    // Nothing was rewritten: the Run is bound exactly as the first session bound it.
    expect(db.getRunRaw(runId)).toMatchObject({
      coordinator_actor: `session:${COORDINATOR}`,
      consumer_generation: generation
    })
  })

  it("stores the successor's own Run under the conversation's address, through a chain of clears", async () => {
    await openChat(COORDINATOR)
    const middle = await clearChat(COORDINATOR)
    const created = await call(
      'orchestration.runCreate',
      { objective: 'next' },
      { sessionId: middle }
    )
    const runId = idOf(created.run)
    expect(db.getRunRaw(runId)!.coordinator_actor).toBe(`session:${COORDINATOR}`)
    const successor = await clearChat(middle)
    runtime.onStructuredSessionStatusForMail({ sessionId: successor, status: 'idle' })

    await expect(
      call('orchestration.runCurrent', {}, { sessionId: successor })
    ).resolves.toMatchObject({ run: { id: runId } })
    expect(db.getRunRaw(runId)!.coordinator_actor).toBe(`session:${COORDINATOR}`)
  })

  it('lands mail sent to any session of the conversation in the live one', async () => {
    await openChat(PEER_CHAT)
    const middle = await clearChat(PEER_CHAT)
    const successor = await clearChat(middle)
    const next = connectionFor(successor)

    for (const [index, spelling] of [PEER_CHAT, middle, successor].entries()) {
      const sent = await call('orchestration.send', {
        from: 'term_worker',
        to: `session:${spelling}`,
        subject: `ping ${index}`
      })
      expect(sent).toMatchObject({ message: { to_handle: `session:${PEER_CHAT}` } })
      await vi.waitFor(() => expect(next.turns).toHaveLength(index + 1), WAIT)
      await settleTurn(successor, index)
    }
    await expect(call('orchestration.check', {}, { sessionId: successor })).resolves.toMatchObject({
      count: 3
    })
  })
})

describe('any live session is addressable by its id', () => {
  it('lands mail sent to `session:<id>` as a turn in that chat, which a flagless check reads', async () => {
    const peer = await openChat(PEER_CHAT)

    const sent = await call('orchestration.send', {
      from: 'term_worker',
      to: `session:${PEER_CHAT}`,
      subject: 'ping'
    })
    expect(sent).toMatchObject({ message: { to_handle: `session:${PEER_CHAT}` } })

    await vi.waitFor(() => expect(peer.turns).toHaveLength(1), WAIT)
    // Direct mail is not in a Run, so the pointer names no `--run`.
    expect(peer.turns[0]!.text).toContain('orchestration check`.')
    expect(peer.turns[0]!.text).toContain('$ORCA_CLI_COMMAND')
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
        to: `session:${PEER_CHAT}`,
        subject: 'ping'
      })
    )
    expect(response).toMatchObject({ ok: false, error: { code: 'session_caller_not_live' } })
    expect(db.getInbox(100)).toEqual([])
  })
})
