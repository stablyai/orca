/**
 * One process with the real structured agent-session host, its record store, journal, lease and
 * Codex adapter; the orchestration database, RPC dispatcher and methods; and the runtime's pointer
 * lanes. Fake: only the Codex app-server child. State is exported as live bindings, set per test by
 * `installStructuredChatRealHost`.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../shared/protocol-version'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { localOrchestrationCliCommand } from './orchestration/cli-command'
import { formatMessagePointer } from './orchestration/formatter'
import type { RpcRequest } from './rpc/core'
import { RpcDispatcher } from './rpc/dispatcher'
import { ORCHESTRATION_METHODS } from './rpc/methods/orchestration'
import { idOf, isRecord, resultOf } from './rpc/orchestration-session-caller-test-fixture'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import {
  attachParams,
  fakeCodex,
  operationId,
  resetProviderFaults,
  type FakeConnection
} from './structured-chat-coordinator-fake-codex-fixture'

export const COORDINATOR = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
export const PEER_CHAT = '7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64'
export const WORKER_PANE = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
export const WORKER_2_PANE = 'tab_worker2:cccccccc-cccc-4ccc-8ccc-cccccccccccc'

export let codex: ReturnType<typeof fakeCodex>
let root: string
export let runtime: OrcaRuntimeService
export let db: OrchestrationDb
export let host: StructuredAgentSessionHost
export let dispatcher: RpcDispatcher
let requests = 0

export function request(
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

export async function call(
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

export async function openChat(sessionId: string): Promise<FakeConnection> {
  const attached = await host.attach({ callerKey: 'test-surface' }, attachParams(sessionId))
  expect(attached, JSON.stringify(attached)).toMatchObject({ ok: true })
  await host.setSessionTabVisibility(sessionId, true)
  threadBySession.set(sessionId, codex.connections.at(-1)!.threadId!)
  return connectionFor(sessionId)
}

const threadBySession = new Map<string, string>()

export function connectionFor(sessionId: string): FakeConnection {
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
export async function settleTurn(sessionId: string, turnIndex: number): Promise<void> {
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
export function sendUserMessage(sessionId: string, text: string) {
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

export async function userTexts(sessionId: string): Promise<string[]> {
  return (await host.journalSnapshot(sessionId)).items.flatMap((item: AgentJournalRenderItem) =>
    item.body?.kind === 'message' && item.body.role === 'user'
      ? item.body.blocks.map((block) => (block.type === 'text' ? block.text : ''))
      : []
  )
}

export async function coordinatorRunAndTask(): Promise<{ runId: string; taskId: string }> {
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
export async function clearChat(sessionId: string): Promise<string> {
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
export async function startSuccessor(successor: string): Promise<void> {
  expect(await sendUserMessage(successor, 'hello')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(connectionFor(successor).turns).toHaveLength(1), WAIT)
  await settleTurn(successor, 0)
}

/** Registers the per-test host, database, runtime and dispatcher this fixture exports. */
export function installStructuredChatRealHost(): void {
  beforeEach(async () => {
    resetProviderFaults()
    root = await mkdtemp(join(tmpdir(), 'orca-structured-chat-real-host-'))
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

  afterEach(async () => {
    await stopStructuredAgentSessionRuntime()
    db.close()
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })
}

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

/** What an Orca restart leaves behind: a fresh runtime and dispatcher over the same database. */
export function restartRuntime(): void {
  runtime = startRuntime()
  dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
}

// Pointers are sent on asynchronous edges; the default 1s wait is too tight under a loaded parallel run.
export const WAIT = { timeout: 10_000 }

export const POINTER =
  /You have 1 orchestration message\. Run `orca(-dev)? orchestration check --run run_\w+`\./

/** The text the PTY lane types into a local terminal for this mailbox, byte for byte. */
export function ptyPointer(mailboxHandle: string): string {
  return formatMessagePointer(1, mailboxHandle, localOrchestrationCliCommand()).trim()
}

/** The text of a turn the fake provider received. */
export function turnText(turn: { text: string }): string {
  const input: unknown = JSON.parse(turn.text)
  return Array.isArray(input)
    ? input.map((item: unknown) => (isRecord(item) ? String(item.text) : '')).join('')
    : ''
}
