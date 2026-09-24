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
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

const COORDINATOR = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
const PEER_CHAT = '7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64'
const WORKSPACE = 'workspace-1'
const WORKER_PANE = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

type FakeConnection = Omit<CodexAppServerConnection, 'closed'> & {
  closed: boolean
  handlers: CodexAppServerConnectionHandlers
  threadId: string | null
  turns: { clientUserMessageId: string; text: string }[]
}

function fakeCodex() {
  const connections: FakeConnection[] = []
  let turnCounter = 0
  const openConnection = (async (_launch, handlers = {}) => {
    const connection: FakeConnection = {
      handlers,
      threadId: null,
      turns: [],
      pid: 4321,
      closed: false,
      request: async (method, params) => {
        const input = (params ?? {}) as Record<string, unknown>
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
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: WORKSPACE,
      workspaceKind: 'git-worktree' as const
    },
    provider: 'codex' as const,
    agent: 'codex',
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
        fields: attachFingerprintFields({ ...params, envelope } as never)
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
  return response.result as Record<string, unknown>
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
async function finishWorker(taskId: string): Promise<void> {
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId,
    startOptions: {}
  })
  const capability = db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: 'term_worker',
    paneKey: WORKER_PANE,
    processIncarnation: 'runtime_test:term_worker:1',
    worktreeId: 'repo::worker',
    effects: [],
    setupState: 'not_applicable'
  })
  db.markWorkerDispatchReady(started.dispatch.id)
  await call(
    'orchestration.send',
    {
      from: 'term_worker',
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
  const runId = (created.run as { id: string }).id
  const task = await call(
    'orchestration.taskCreate',
    { spec: 'build it' },
    {
      sessionId: COORDINATOR
    }
  )
  return { runId, taskId: (task.task as { id: string }).id }
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
    handle === 'term_worker' ? WORKER_PANE : null
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
    releaseGraceMs: 60_000,
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

const POINTER = /You have 1 orchestration message\. Run `orca orchestration check --run run_/

describe('a worker result reaches the structured chat that coordinates it', () => {
  it('lands as a turn in the coordinator journal, and a flagless check returns the worker_done', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()

    await finishWorker(taskId)

    // No user action: the result itself sends the chat a turn through the host's send.
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1))
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
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1))

    // A pending send is not an acknowledgement, so the mail is retained and retried on every edge
    // until the host confirms it: before the echo, and again at the turn's idle edge.
    runtime.deliverPendingMessagesForHandle(`run:${runId}`)
    await settleTurn(COORDINATOR, 0)
    runtime.deliverPendingMessagesForHandle(`run:${runId}`)
    await vi.waitFor(() =>
      expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toEqual([])
    )
    expect(chat.turns).toHaveLength(1)
    expect(userTexts(COORDINATOR)).toHaveLength(1)
  })

  it('wakes a coordinator the host evicted, and delivers once it is back', async () => {
    await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    // What the release clock does to a chat nobody is looking at: child stopped, lease released.
    await host.close(COORDINATOR)
    expect(host.hasSession(COORDINATOR)).toBe(false)
    const before = codex.connections.length

    await finishWorker(taskId)

    await vi.waitFor(() => expect(codex.connections.length).toBe(before + 1))
    const revived = connectionFor(COORDINATOR)
    await vi.waitFor(() => expect(revived.turns).toHaveLength(1))
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
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2))
    expect(chat.turns[1]!.text).toMatch(POINTER)
    expect(chat.turns[1]!.text).toContain(runId)
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

    await vi.waitFor(() => expect(peer.turns).toHaveLength(1))
    // Direct mail is not in a Run, so the pointer names no `--run`.
    expect(peer.turns[0]!.text).toContain('Run `orca orchestration check`.')
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
    expect(response).toMatchObject({ ok: false, error: { code: 'session_recipient_ended' } })
    expect(db.getInbox(100)).toEqual([])
  })
})
