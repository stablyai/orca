// One structured Codex session driven end to end over `agentSession.*`.
//
// Nothing here is stubbed except the Codex child itself: the RPC dispatcher, the
// zod schemas, the capability gate, the durable record store, the journal, the
// lease, the Codex adapter, and the event-to-journal translation are all the ones
// that ship. The fake app-server answers the same JSON-RPC calls the real one
// does and pushes the same notifications and blocking requests back.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  openCodexAppServerConnection
} from '../codex/codex-app-server-connection'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import type {
  AgentSessionHistoryResult,
  AgentSessionSubscribeEvent
} from '../../shared/agent-session-wire'
import { attachFingerprintFields } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { journalDirectoryFor } from '../native-chat/agent-session-journal/journal-paths'
import { readJournalBlob } from '../native-chat/agent-session-journal/journal-blob-store'
import { appendLegacyTranscriptMessages } from '../native-chat/agent-session-journal/journal-legacy-import'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { openAgentSessionJournal } from '../native-chat/agent-session-journal/journal-store-factory'
import type { OrcaRuntimeService } from './orca-runtime'
import type { RpcRequest, RpcResponse } from './rpc/core'
import { RpcDispatcher } from './rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from './rpc/methods/structured-agent-session'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

const SESSION = 'session-integration-1'
const THREAD = 'thread-integration'
const TURN = 'turn-1'
const WORKSPACE = 'workspace-1'
const CLIENT = {
  clientId: 'device-a',
  clientKind: 'runtime' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
}

// ─── the fake `codex app-server` ────────────────────────────────────────────

type CodexScript = {
  connections: FakeConnection[]
  openConnection: typeof openCodexAppServerConnection
  live: () => FakeConnection
  notify: (method: string, params: unknown) => void
  ask: (id: number, method: string, params: unknown) => void
}

// `closed` is readonly on the real connection; the fake flips it so the test can
// see the takeover reap the previous child.
type FakeConnection = Omit<CodexAppServerConnection, 'closed'> & {
  closed: boolean
  handlers: CodexAppServerConnectionHandlers
  calls: { method: string; params?: Record<string, unknown> }[]
  replies: { id: number | string; result?: unknown; code?: number }[]
  resumedThreadId: string | null
  launch: Parameters<typeof openCodexAppServerConnection>[0]
}

function fakeCodex(): CodexScript {
  const connections: FakeConnection[] = []
  const openConnection = (async (launch, handlers = {}) => {
    const connection: FakeConnection = {
      launch,
      handlers,
      calls: [],
      replies: [],
      resumedThreadId: null,
      pid: 4321,
      closed: false,
      request: async (method, params) => {
        connection.calls.push({ method, params })
        if (method === 'thread/start') {
          return { thread: { id: THREAD, path: '/rollouts/integration.jsonl' } }
        }
        if (method === 'thread/resume') {
          connection.resumedThreadId = (params as { threadId: string }).threadId
          return { thread: { id: connection.resumedThreadId } }
        }
        if (method === 'turn/start') {
          return { turn: { id: TURN } }
        }
        if (method === 'model/list') {
          return {
            data: [
              {
                model: 'gpt-live',
                displayName: 'GPT Live',
                hidden: false,
                supportedReasoningEfforts: [
                  { reasoningEffort: 'medium', description: 'Balanced' },
                  { reasoningEffort: 'high', description: 'Deep reasoning' }
                ],
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
      respond: (id, result) => connection.replies.push({ id, result }),
      respondWithError: (id, code) => connection.replies.push({ id, code }),
      close: async () => {
        connection.closed = true
        return true
      }
    }
    connections.push(connection)
    return connection
  }) as typeof openCodexAppServerConnection
  const live = (): FakeConnection => {
    const connection = connections.at(-1)
    if (!connection) {
      throw new Error('no codex app-server has been opened')
    }
    return connection
  }
  return {
    connections,
    openConnection,
    live,
    notify: (method, params) => live().handlers.onNotification?.(method, params),
    ask: (id, method, params) => live().handlers.onServerRequest?.({ id, method, params })
  }
}

// ─── the RPC client ─────────────────────────────────────────────────────────

let operations = 0

/** `<13-digit ms>-<32 hex>`, the only shape the durable ledger accepts. Real
 *  time, not a frozen constant: the runtime under test stamps the ledger with
 *  its own clock and refuses a future-dated id. */
function operationId(): string {
  operations += 1
  return `${Date.now()}-${operations.toString(16).padStart(32, '0')}`
}

function envelope(method: string, fields: Record<string, unknown>, fence: number | null) {
  return {
    sessionId: SESSION,
    clientOperationId: operationId(),
    expectedRuntimeFence: fence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

function attachParams(fence: number | null) {
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
    runtimeKind: 'native' as const,
    providerHandle: { kind: 'codex' as const, threadId: THREAD }
  }
  const envelope = {
    sessionId: SESSION,
    clientOperationId: operationId(),
    expectedRuntimeFence: fence,
    payloadFingerprint: ''
  }
  return {
    ...params,
    envelope: {
      ...envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.attach',
        sessionId: SESSION,
        fields: attachFingerprintFields({ ...params, envelope } as never)
      })
    }
  }
}

function createIntentParams() {
  const worktree = `id:${WORKSPACE}`
  const fields = { worktree, agent: 'codex' }
  return { envelope: envelope('agentSession.create', fields, null), ...fields }
}

let codex: CodexScript
let root: string
let dispatcher: RpcDispatcher
let bootEnvironmentReads: number
let codexOverrideReads: number
let configuredCodexProfile: string

/** Runs a one-shot method and returns its decoded reply. */
async function call(method: string, params: unknown): Promise<RpcResponse> {
  const replies: RpcResponse[] = []
  const request: RpcRequest = { id: `req-${operations}`, authToken: 'token', method, params }
  await dispatcher.dispatchStreaming(request, (raw) => replies.push(JSON.parse(raw)), CLIENT)
  const first = replies[0]
  if (!first) {
    throw new Error(`no reply for ${method}`)
  }
  return first
}

/** Asserts success and unwraps the host's `{ok:true, value}` mutation result. */
async function ok<T>(method: string, params: unknown): Promise<T> {
  const response = await call(method, params)
  expect(response, `${method} failed: ${JSON.stringify(response)}`).toMatchObject({ ok: true })
  const result = (response as { result: { ok: boolean; value?: T; refusal?: unknown } }).result
  expect(result, `${method} refused: ${JSON.stringify(result.refusal)}`).toMatchObject({ ok: true })
  return result.value as T
}

/** Opens a live subscription and keeps collecting frames after the call settles. */
async function subscribe(
  requestId: string,
  cursor?: { epoch: string; sequence: number }
): Promise<AgentSessionSubscribeEvent[]> {
  const frames: AgentSessionSubscribeEvent[] = []
  await dispatcher.dispatchStreaming(
    {
      id: requestId,
      authToken: 'token',
      method: 'agentSession.subscribe',
      params: { sessionId: SESSION, ...(cursor ? { cursor } : {}) }
    },
    (raw) => {
      const response = JSON.parse(raw) as { ok: boolean; result?: AgentSessionSubscribeEvent }
      if (response.ok && response.result) {
        frames.push(response.result)
      }
    },
    CLIENT
  )
  return frames
}

/** Settles everything the provider streamed into the journal. Real clients see
 *  these rows arrive on the subscription; a test has to wait for them. */
function drainStreamedEvents(): Promise<void> {
  return getStructuredAgentSessionHost()?.flushStreamedEvents(SESSION) ?? Promise.resolve()
}

function textOf(item: AgentJournalRenderItem): string {
  const body = item.body
  return body?.kind === 'message'
    ? body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
    : ''
}

async function historyPage(
  direction: 'tail' | 'before' | 'after',
  extra: Record<string, unknown> = {}
): Promise<AgentSessionHistoryResult> {
  const response = await call('agentSession.history', {
    sessionId: SESSION,
    direction,
    ...extra
  })
  return (response as { result: AgentSessionHistoryResult }).result
}

beforeEach(async () => {
  operations = 0
  root = await mkdtemp(join(tmpdir(), 'orca-structured-integration-'))
  codex = fakeCodex()
  bootEnvironmentReads = 0
  codexOverrideReads = 0
  configuredCodexProfile = 'configured'
  const runtime = {
    getRuntimeId: () => 'runtime-1',
    getStructuredAgentSessionCreateSupport: async () => ({ supported: true }),
    resolveStructuredAgentSessionCreateIntent: async () => {
      const {
        envelope: _envelope,
        providerHandle: _providerHandle,
        ...resolved
      } = attachParams(null)
      return resolved
    },
    publishStructuredAgentSessionTab: () => {},
    ensureStructuredAgentSessionHost: () =>
      ensureStructuredAgentSessionHost({
        stateDirectory: root,
        hostId: 'local',
        claimKeyId: 'key-1',
        resolveWorkspacePath: async (workspaceId) => `/repos/${workspaceId}`,
        resolveCodexCommand: () => '/usr/local/bin/codex',
        resolveEnvironment: async () => {
          bootEnvironmentReads += 1
          return {
            PATH: '/shell/bin:/usr/bin',
            EXAMPLE_GATEWAY_TOKEN: 'shell-exported',
            CODEX_HOME: '/shell/home'
          }
        },
        resolveCodexOverrides: () => {
          codexOverrideReads += 1
          return { CODEX_PROFILE: configuredCodexProfile }
        },
        openCodexConnection: codex.openConnection,
        readProcessStartTime: async () => 1_700_000_000_000
      }).then(() => undefined),
    registerOwnedSubscriptionCleanup: vi.fn((_id: string, dispose: () => void) => {
      return {
        releaseIfCurrent: dispose
      }
    })
  }
  dispatcher = new RpcDispatcher({
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: STRUCTURED_AGENT_SESSION_METHODS
  })
})

function itemsOf(frames: AgentSessionSubscribeEvent[]): AgentJournalRenderItem[] {
  const items = new Map<string, AgentJournalRenderItem>()
  for (const frame of frames) {
    const published =
      frame.type === 'snapshot' || frame.type === 'reset'
        ? frame.page.items
        : frame.type === 'batch'
          ? frame.batch.items
          : []
    for (const item of published) {
      items.set(item.itemId, item)
    }
  }
  return [...items.values()]
}

function cursorOf(frames: AgentSessionSubscribeEvent[]): { epoch: string; sequence: number } {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index] as AgentSessionSubscribeEvent
    if (frame.type === 'batch') {
      return frame.batch.cursor
    }
    if (frame.type === 'snapshot' || frame.type === 'reset') {
      return frame.page.liveCursor ?? frame.page.window.nextCursor
    }
  }
  throw new Error('subscription published no cursor')
}

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  await rm(root, { recursive: true, force: true })
})

describe('a structured codex session over agentSession.*', () => {
  it('hydrates provider options after activating a legacy-imported journal', async () => {
    const identity = {
      sessionId: SESSION,
      workspaceId: WORKSPACE,
      hostId: 'local',
      agent: 'codex' as const,
      providerHandle: { kind: 'codex' as const, threadId: THREAD }
    }
    const journal = await openAgentSessionJournal({
      identity,
      journalDir: journalDirectoryFor(root, identity)
    })
    await appendLegacyTranscriptMessages({
      journal,
      agent: 'codex',
      sessionId: THREAD,
      fence: 0,
      messages: [
        {
          id: 'legacy-user-1',
          role: 'user',
          source: 'transcript',
          timestamp: 1_800_000_000_000,
          blocks: [{ type: 'text', text: 'legacy question' }]
        }
      ]
    })

    const created = await ok<{ page: { items: AgentJournalRenderItem[] } }>(
      'agentSession.create',
      createIntentParams()
    )
    expect(created.page.items.map(textOf)).toContain('legacy question')
    expect(await call('agentSession.options', { sessionId: SESSION })).toMatchObject({
      ok: true,
      result: {
        models: [{ id: 'gpt-live', defaultEffort: 'medium' }],
        current: { model: 'gpt-live' }
      }
    })
  })

  it('dispatches and streams a plain first send from a fresh session', async () => {
    const created = await ok<{ fence: number; page: { items: unknown[] } }>(
      'agentSession.create',
      createIntentParams()
    )
    expect(created.page.items).toEqual([])
    expect(codex.live().launch.env).toMatchObject({
      CODEX_PROFILE: 'configured',
      EXAMPLE_GATEWAY_TOKEN: 'shell-exported',
      CODEX_HOME: '/home/dev/.codex'
    })
    const store = await readFile(join(root, 'agent-sessions', 'agent-sessions.json'), 'utf-8')
    expect(store).not.toContain('EXAMPLE_GATEWAY_TOKEN')
    expect(store).not.toContain('"launchEnv"')
    const stream = await subscribe('sub-first-send')
    const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] }

    const sent = await ok<{
      clientMessageId: string
      submission: { dispatchState: string; providerItemId: string | null }
    }>('agentSession.send', {
      envelope: envelope('agentSession.send', { body }, created.fence),
      body
    })
    expect(sent.submission).toMatchObject({
      dispatchState: 'accepted',
      providerItemId: `codex:${THREAD}:${TURN}:0`
    })
    expect(codex.live().calls.at(-1)).toMatchObject({
      method: 'turn/start',
      params: { threadId: THREAD, clientUserMessageId: sent.clientMessageId }
    })

    codex.notify('turn/started', { turn: { id: TURN } })
    codex.notify('item/completed', {
      item: { type: 'userMessage', id: 'item-0', content: [{ type: 'text', text: 'hi' }] }
    })
    codex.notify('item/started', { item: { type: 'agentMessage', id: 'item-1', text: '' } })
    codex.notify('item/agentMessage/delta', { itemId: 'item-1', delta: 'Hello.' })
    codex.notify('item/completed', {
      item: { type: 'agentMessage', id: 'item-1', text: 'Hello.' }
    })
    await drainStreamedEvents()

    expect(itemsOf(stream).map(textOf).filter(Boolean)).toEqual(['hi', 'Hello.'])
  })

  it('runs create → send → stream → approval → cancel → reconnect → page history', async () => {
    // ── create ──────────────────────────────────────────────────────────────
    // No host exists yet; `create` is the call that builds one.
    expect(getStructuredAgentSessionHost()).toBeNull()
    const created = await ok<{ fence: number; page: { items: unknown[] } }>(
      'agentSession.create',
      createIntentParams()
    )
    expect(created.page.items).toEqual([])
    expect(codex.live().calls[0]).toMatchObject({
      method: 'thread/start',
      params: { cwd: `/repos/${WORKSPACE}` }
    })
    const fence = created.fence

    const stream = await subscribe('sub-1')
    expect(stream[0]).toMatchObject({ type: 'snapshot', sessionId: SESSION })

    // ── options ─────────────────────────────────────────────────────────────
    const options = await call('agentSession.options', { sessionId: SESSION })
    expect(options).toMatchObject({
      ok: true,
      result: {
        models: [{ id: 'gpt-live', defaultEffort: 'medium' }],
        current: { model: 'gpt-live' }
      }
    })
    await ok('agentSession.setOption', {
      envelope: envelope('agentSession.setOption', { key: 'model', value: 'gpt-live' }, fence),
      key: 'model',
      value: 'gpt-live'
    })
    await ok('agentSession.setOption', {
      envelope: envelope('agentSession.setOption', { key: 'effort', value: 'high' }, fence),
      key: 'effort',
      value: 'high'
    })
    expect(await call('agentSession.options', { sessionId: SESSION })).toMatchObject({
      ok: true,
      result: { current: { model: 'gpt-live', effort: 'high' } }
    })
    expect(itemsOf(stream)).toEqual([])

    // ── send ────────────────────────────────────────────────────────────────
    const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'list files' }] }
    const sent = await ok<{
      clientMessageId: string
      submission: { dispatchState: string; providerItemId: string | null }
    }>('agentSession.send', {
      envelope: envelope('agentSession.send', { body }, fence),
      body
    })
    // Codex named the turn, so the submission is accepted rather than
    // "delivery unconfirmed", and adopts the provider's own item identity.
    expect(sent.submission).toMatchObject({
      dispatchState: 'accepted',
      providerItemId: `codex:${THREAD}:${TURN}:0`
    })
    expect(codex.live().calls.at(-1)).toMatchObject({
      method: 'turn/start',
      params: {
        threadId: THREAD,
        clientUserMessageId: sent.clientMessageId,
        model: 'gpt-live',
        effort: 'high'
      }
    })

    // ── stream ──────────────────────────────────────────────────────────────
    codex.notify('turn/started', { turn: { id: TURN } })
    // Codex echoes the user message back as ordinal 0 of the turn. That is the
    // key the submission adopted, so the echo has to reconcile into the bubble
    // the client already has rather than append a second copy of it.
    codex.notify('item/completed', {
      item: { type: 'userMessage', id: 'item-0', content: [{ type: 'text', text: 'list files' }] }
    })
    await drainStreamedEvents()
    expect(itemsOf(stream).filter((item) => textOf(item) === 'list files')).toHaveLength(1)

    codex.notify('item/started', { item: { type: 'agentMessage', id: 'item-1', text: '' } })
    codex.notify('item/agentMessage/delta', { itemId: 'item-1', delta: 'Two ' })
    codex.notify('item/agentMessage/delta', { itemId: 'item-1', delta: 'files.' })
    await drainStreamedEvents()
    // The 60ms window has not elapsed, so no half-written row reached the
    // journal — the coalescer is holding both deltas.
    expect(itemsOf(stream).filter((item) => textOf(item).startsWith('Two'))).toEqual([])

    codex.notify('item/completed', {
      item: { type: 'agentMessage', id: 'item-1', text: 'Two files.' }
    })
    await drainStreamedEvents()
    const answer = itemsOf(stream).find((item) => textOf(item) === 'Two files.')
    // Keyed by (threadId, turnId, ordinal), so a resumed thread reuses this row.
    expect(answer?.itemId).toBe(`codex:${THREAD}:${TURN}:1`)

    // ── approval ────────────────────────────────────────────────────────────
    codex.notify('item/started', {
      item: { type: 'commandExecution', id: 'item-2', command: 'ls -la', status: 'inProgress' }
    })
    codex.ask(7, 'item/commandExecution/requestApproval', {
      threadId: THREAD,
      turnId: TURN,
      itemId: 'item-2',
      availableDecisions: ['accept', 'decline']
    })
    await drainStreamedEvents()
    const approval = itemsOf(stream).find((item) => item.body?.kind === 'approval')
    expect(approval?.body).toMatchObject({ title: 'Run a command?', detail: 'ls -la' })

    const answered = await ok<{ resolution: { state: string; selectedOptionId: string } }>(
      'agentSession.respondToApproval',
      {
        envelope: envelope(
          'agentSession.respondTo:approval',
          {
            itemId: approval?.itemId,
            expectedRevision: approval?.revision,
            optionId: 'accept'
          },
          fence
        ),
        itemId: approval?.itemId,
        expectedRevision: approval?.revision,
        optionId: 'accept'
      }
    )
    expect(answered.resolution).toMatchObject({ state: 'resolved', selectedOptionId: 'accept' })
    // The durable journal item id round-tripped back to the live Codex request.
    expect(codex.live().replies).toEqual([{ id: 7, result: { decision: 'accept' } }])

    // ── cancel ──────────────────────────────────────────────────────────────
    const cancelled = await ok<{ turnId: string; cancelled: boolean }>('agentSession.cancel', {
      envelope: envelope('agentSession.cancel', { turnId: TURN }, fence),
      turnId: TURN
    })
    expect(cancelled).toEqual({ turnId: TURN, cancelled: true })
    expect(codex.live().calls.at(-1)).toMatchObject({
      method: 'turn/interrupt',
      params: { threadId: THREAD, turnId: TURN }
    })

    // ── reconnect ───────────────────────────────────────────────────────────
    // The client drops. Its subscription is reaped; the session and its child
    // are not.
    await call('agentSession.unsubscribe', { sessionId: SESSION })
    const lastCursor = cursorOf(stream)
    codex.notify('item/completed', {
      item: { type: 'agentMessage', id: 'item-3', text: 'Stopped.' }
    })
    codex.notify('turn/completed', { turn: { id: TURN } })
    await drainStreamedEvents()

    // Resubscribing from the cursor it held replays only what it missed.
    const missed = await subscribe('sub-2', lastCursor)
    expect(missed[0]?.type).toBe('batch')
    expect(
      itemsOf(missed).some(
        (item) => item.body?.kind === 'tool-call' && item.body.state === 'failed'
      )
    ).toBe(true)
    expect(itemsOf(missed).map(textOf).filter(Boolean)).toEqual(['Stopped.'])

    // A runtime taking the session over is the other half of reconnect: the
    // fence advances, the old child is reaped, and its replacement resumes the
    // thread this session proved rather than forking a new one.
    const reaped = codex.live()
    const resumed = await ok<{ fence: number; page: { items: AgentJournalRenderItem[] } }>(
      'agentSession.ensure',
      attachParams(fence)
    )
    expect(resumed.fence).toBe(fence + 1)
    expect(reaped.closed).toBe(true)
    expect(codex.live().resumedThreadId).toBe(THREAD)
    expect(await call('agentSession.options', { sessionId: SESSION })).toMatchObject({
      ok: true,
      result: {
        models: [{ id: 'gpt-live', defaultEffort: 'medium' }],
        current: { model: 'gpt-live', effort: 'high' }
      }
    })
    // The journal belongs to the session, not to the process that just died.
    expect(resumed.page.items.map(textOf)).toContain('Two files.')

    // ── page history ────────────────────────────────────────────────────────
    const tail = await historyPage('tail', { limit: 2 })
    expect(tail.ok).toBe(true)
    if (!tail.ok) {
      throw new Error('history reset')
    }
    expect(tail.page.hasOlder).toBe(true)
    const older = await historyPage('before', {
      cursor: tail.page.window.nextCursor,
      limit: 10
    })
    if (!older.ok) {
      throw new Error('history reset')
    }
    expect(older.page.hasOlder).toBe(false)
    // Every step of the conversation, in order, from the durable journal alone —
    // no page overlaps another, and nothing the live stream showed is missing.
    expect([...older.page.items, ...tail.page.items].map((item) => item.body?.kind)).toEqual([
      'message',
      'message',
      'tool-call',
      'approval',
      'status',
      'message'
    ])
    expect([...older.page.items, ...tail.page.items].map(textOf)).toEqual([
      'list files',
      'Two files.',
      '',
      '',
      '',
      'Stopped.'
    ])
  })

  it('caches shell exports but re-reads configured overrides for a resume', async () => {
    const created = await ok<{ fence: number }>('agentSession.create', createIntentParams())
    expect({ bootEnvironmentReads, codexOverrideReads }).toEqual({
      bootEnvironmentReads: 1,
      codexOverrideReads: 1
    })

    configuredCodexProfile = 'updated'
    const resumed = await ok<{ fence: number }>('agentSession.ensure', attachParams(created.fence))

    expect(resumed.fence).toBe(created.fence + 1)
    expect(codex.live().resumedThreadId).toBe(THREAD)
    expect(codex.live().launch.env).toMatchObject({ CODEX_PROFILE: 'updated' })
    expect({ bootEnvironmentReads, codexOverrideReads }).toEqual({
      bootEnvironmentReads: 1,
      codexOverrideReads: 2
    })
  })

  it('refuses to build a host for a client that never advertised the capability', async () => {
    const replies: RpcResponse[] = []
    await dispatcher.dispatchStreaming(
      {
        id: 'req-gate',
        authToken: 'token',
        method: 'agentSession.create',
        params: attachParams(null)
      },
      (raw) => replies.push(JSON.parse(raw)),
      { clientKind: 'runtime', clientCapabilities: ['terminal.stream.v1'] }
    )

    expect(replies[0]).toMatchObject({ ok: false })
    // Building the host is itself observable — it opens a store and spawns a
    // child — so the gate has to run before it, not after.
    expect(getStructuredAgentSessionHost()).toBeNull()
    expect(codex.connections).toEqual([])
  })

  it('joins final deferred writes before runtime teardown completes', async () => {
    await ok<{ fence: number }>('agentSession.create', createIntentParams())
    codex.notify('turn/started', { threadId: THREAD, turn: { id: TURN } })
    codex.notify('item/started', {
      threadId: THREAD,
      turnId: TURN,
      item: { type: 'agentMessage', id: 'item-final', text: '' }
    })
    await drainStreamedEvents()

    codex.notify('item/agentMessage/delta', {
      threadId: THREAD,
      turnId: TURN,
      itemId: 'item-final',
      delta: 'Final text before shutdown.'
    })
    const host = getStructuredAgentSessionHost()
    const journal = (
      host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
    ).sessions.get(SESSION)!.journal
    const appendEntered = Promise.withResolvers<void>()
    const appendGate = Promise.withResolvers<void>()
    const originalAppend = journal.appendItem.bind(journal)
    vi.spyOn(journal, 'appendItem').mockImplementationOnce(async (...args) => {
      appendEntered.resolve()
      await appendGate.promise
      return originalAppend(...args)
    })

    let stopped = false
    const stopping = stopStructuredAgentSessionRuntime().then(() => {
      stopped = true
    })
    await appendEntered.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    const waitedForFinalAppend = !stopped
    appendGate.resolve()
    await stopping

    expect(waitedForFinalAppend).toBe(true)
    const identity = {
      sessionId: SESSION,
      workspaceId: WORKSPACE,
      hostId: 'local',
      agent: 'codex' as const,
      providerHandle: { kind: 'codex' as const, threadId: THREAD }
    }
    const reopened = await openAgentSessionJournal({
      identity,
      journalDir: journalDirectoryFor(root, identity)
    })
    expect(reopened.snapshot().items.map(textOf)).toContain('Final text before shutdown.')
    expect(
      reopened
        .snapshot()
        .items.some(
          (item) => item.body?.kind === 'status' && item.body.turnLifecycle?.state === 'running'
        )
    ).toBe(false)
  })

  it('persists truncated command output before publishing its journal row', async () => {
    await ok<{ fence: number }>('agentSession.create', createIntentParams())
    const output = 'large command output\n'.repeat(2_000)

    codex.notify('item/completed', {
      threadId: THREAD,
      turnId: TURN,
      item: {
        type: 'commandExecution',
        id: 'item-large-output',
        command: 'print-many-lines',
        status: 'completed',
        exitCode: 0,
        aggregatedOutput: output
      }
    })
    await drainStreamedEvents()

    const host = getStructuredAgentSessionHost()
    const journal = (
      host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
    ).sessions.get(SESSION)!.journal
    const item = journal.snapshot().items.find((candidate) => candidate.body?.kind === 'tool-call')
    const bounded = item?.body?.kind === 'tool-call' ? item.body.output : undefined
    expect(bounded).toMatchObject({ truncated: true, byteLength: Buffer.byteLength(output) })
    expect(await readJournalBlob(journal.directory, bounded?.digest ?? '')).toBe(output)
  })

  it('keeps an answered prompt resolved after the provider exits', async () => {
    const created = await ok<{ fence: number }>('agentSession.create', createIntentParams())
    codex.notify('turn/started', { threadId: THREAD, turn: { id: TURN } })
    codex.notify('item/started', {
      threadId: THREAD,
      turnId: TURN,
      item: {
        type: 'commandExecution',
        id: 'item-needs-answer',
        command: 'build',
        status: 'inProgress'
      }
    })
    codex.ask(9, 'item/commandExecution/requestApproval', {
      threadId: THREAD,
      turnId: TURN,
      itemId: 'item-needs-answer',
      availableDecisions: ['accept', 'decline']
    })
    await drainStreamedEvents()
    const host = getStructuredAgentSessionHost()
    const journal = (
      host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
    ).sessions.get(SESSION)!.journal
    const approval = journal.snapshot().items.find((item) => item.body?.kind === 'approval')
    expect(approval?.body).toMatchObject({
      kind: 'approval',
      resolution: { state: 'pending' }
    })

    await ok('agentSession.respondToApproval', {
      envelope: envelope(
        'agentSession.respondTo:approval',
        {
          itemId: approval?.itemId,
          expectedRevision: approval?.revision,
          optionId: 'accept'
        },
        created.fence
      ),
      itemId: approval?.itemId,
      expectedRevision: approval?.revision,
      optionId: 'accept'
    })
    codex.live().handlers.onExit?.(new Error('provider exited after answer'))
    await drainStreamedEvents()

    expect(
      journal.snapshot().items.find((item) => item.itemId === approval?.itemId)?.body
    ).toMatchObject({
      kind: 'approval',
      resolution: { state: 'resolved', selectedOptionId: 'accept' }
    })
  })
})
