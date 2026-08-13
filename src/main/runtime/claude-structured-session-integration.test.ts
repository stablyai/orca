import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../shared/agent-session-wire'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type {
  ClaudeStreamJsonConnection,
  ClaudeStreamJsonConnectionHandlers,
  ClaudeStreamJsonLaunch,
  openClaudeStreamJsonConnection
} from '../claude/claude-stream-json-connection'
import { claudeSessionIdForOrcaSession } from '../claude/claude-structured-launch-resolution'
import {
  CLAUDE_SPAWN_TOKEN_ENV,
  claudeProviderHandleLink
} from '../claude/claude-structured-owner-identity'
import { attachFingerprintFields } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type {
  StructuredAgentSessionHandoffTransport,
  StructuredTuiOwner
} from '../native-chat/agent-session-wire/structured-agent-session-handoff-types'
import type { OrcaRuntimeService } from './orca-runtime'
import type { RpcRequest, RpcResponse } from './rpc/core'
import { RpcDispatcher } from './rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from './rpc/methods/structured-agent-session'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

const SESSION = 'claude-integration-1'
const PROVIDER_SESSION = claudeSessionIdForOrcaSession(SESSION)
const WORKSPACE = 'workspace-claude'
const CLIENT = {
  clientKind: 'mobile' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
}

type FakeClaudeConnection = Omit<ClaudeStreamJsonConnection, 'closed'> & {
  closed: boolean
  launch: ClaudeStreamJsonLaunch
  handlers: ClaudeStreamJsonConnectionHandlers
  calls: { subtype: string; params?: Record<string, unknown> }[]
  sent: Record<string, unknown>[]
  replies: { requestId: string; response: unknown }[]
}

function fakeClaude() {
  const connections: FakeClaudeConnection[] = []
  let initializeAccount: unknown
  const openConnection = (async (launch, handlers = {}) => {
    const connection: FakeClaudeConnection = {
      launch,
      handlers,
      calls: [],
      sent: [],
      replies: [],
      pid: 4321 + connections.length,
      closed: false,
      request: async (subtype, params) => {
        connection.calls.push({ subtype, params })
        if (subtype === 'initialize') {
          handlers.onMessage?.({
            type: 'system',
            subtype: 'init',
            session_id: PROVIDER_SESSION,
            ...(connections.length === 0 ? { uuid: 'init-leaf' } : {}),
            model: 'claude-sonnet-5',
            apiKeySource: 'none'
          })
          return {
            models: [{ value: 'sonnet', displayName: 'Sonnet' }],
            ...(initializeAccount === undefined ? {} : { account: initializeAccount })
          }
        }
        return subtype === 'get_settings' ? { env: {} } : {}
      },
      send: async (message) => {
        connection.sent.push(message)
        if (message.type === 'user') {
          handlers.onMessage?.({ ...message, uuid: 'user-1' })
        }
      },
      respond: async (requestId, response) => {
        connection.replies.push({ requestId, response })
      },
      respondWithError: async () => {},
      close: async () => {
        connection.closed = true
      }
    }
    connections.push(connection)
    return connection
  }) as typeof openClaudeStreamJsonConnection
  const live = (): FakeClaudeConnection => {
    const connection = connections.at(-1)
    if (!connection) {
      throw new Error('no Claude connection')
    }
    return connection
  }
  return {
    connections,
    openConnection,
    live,
    setInitializeAccount: (account: unknown) => {
      initializeAccount = account
    }
  }
}

let operations = 0

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

function createIntentParams() {
  const worktree = `id:${WORKSPACE}`
  const fields = { worktree, agent: 'claude' }
  return { envelope: envelope('agentSession.create', fields, null), ...fields }
}

function ensureParams(fence: number) {
  const params = {
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: WORKSPACE,
      workspaceKind: 'git-worktree' as const
    },
    provider: 'claude' as const,
    agent: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR' as const, path: join(root, 'claude-home') },
    runtimeKind: 'native' as const,
    providerHandle: {
      kind: 'claude' as const,
      sessionId: PROVIDER_SESSION,
      leafUuid: 'assistant-leaf'
    }
  }
  const base = {
    sessionId: SESSION,
    clientOperationId: operationId(),
    expectedRuntimeFence: fence,
    payloadFingerprint: ''
  }
  return {
    ...params,
    envelope: {
      ...base,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.attach',
        sessionId: SESSION,
        fields: attachFingerprintFields({ ...params, envelope: base } as never)
      })
    }
  }
}

function handoffParams(direction: 'to-native' | 'to-tui', fence: number) {
  const fields = { direction, mode: 'now' as const, action: 'start' as const }
  return {
    envelope: envelope('agentSession.requestHandoff', fields, fence),
    ...fields
  }
}

let claude: ReturnType<typeof fakeClaude>
let root: string
let dispatcher: RpcDispatcher
let cleanups: Map<string, () => void>
let tuiOwner: StructuredTuiOwner | null
let transcriptPath: string

async function call(method: string, params: unknown): Promise<RpcResponse> {
  const replies: RpcResponse[] = []
  const request: RpcRequest = { id: `req-${operations}`, authToken: 'token', method, params }
  await dispatcher.dispatchStreaming(request, (raw) => replies.push(JSON.parse(raw)), CLIENT)
  if (!replies[0]) {
    throw new Error(`no reply for ${method}`)
  }
  return replies[0]
}

async function ok<T>(method: string, params: unknown): Promise<T> {
  const response = await call(method, params)
  expect(response, JSON.stringify(response)).toMatchObject({ ok: true })
  const result = (response as { result: { ok: boolean; value?: T } }).result
  expect(result).toMatchObject({ ok: true })
  return result.value as T
}

async function subscribe(): Promise<AgentSessionSubscribeEvent[]> {
  const frames: AgentSessionSubscribeEvent[] = []
  await dispatcher.dispatchStreaming(
    {
      id: 'subscribe-1',
      authToken: 'token',
      method: 'agentSession.subscribe',
      params: { sessionId: SESSION }
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

function itemsOf(frames: AgentSessionSubscribeEvent[]): AgentJournalRenderItem[] {
  const items = new Map<string, AgentJournalRenderItem>()
  for (const frame of frames) {
    const rows =
      frame.type === 'snapshot' || frame.type === 'reset'
        ? frame.snapshot.items
        : frame.type === 'batch'
          ? frame.batch.items
          : []
    for (const row of rows) {
      items.set(row.itemId, row)
    }
  }
  return [...items.values()]
}

function textOf(item: AgentJournalRenderItem): string {
  return item.body?.kind === 'message'
    ? item.body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
    : ''
}

beforeEach(async () => {
  operations = 0
  root = await mkdtemp(join(tmpdir(), 'orca-claude-structured-integration-'))
  transcriptPath = join(root, 'claude-home', 'projects', 'workspace', `${PROVIDER_SESSION}.jsonl`)
  await mkdir(join(root, 'claude-home', 'projects', 'workspace'), { recursive: true })
  claude = fakeClaude()
  tuiOwner = null
  cleanups = new Map()
  const handoffTransport: StructuredAgentSessionHandoffTransport = {
    hostLabel: 'Scripted Claude host',
    launchTui: async ({ record, fence, spawnToken }) => {
      const head = record.providerHandleChain.at(-1)?.handle
      tuiOwner = {
        terminal: {
          handle: 'term-claude-tui',
          tabId: 'tab-claude-tui',
          paneKey: 'tab-claude-tui:leaf-claude-tui',
          ptyId: 'pty-claude-tui'
        },
        process: {
          hostId: 'local',
          pid: 7331,
          processStartTimeMs: 100,
          spawnToken
        },
        link: claudeProviderHandleLink({
          sessionId: PROVIDER_SESSION,
          leafUuid: head?.provider === 'claude' ? head.leafUuid : null,
          resumed: true,
          fence,
          observedAt: Date.now()
        }),
        transcriptPath
      }
      return tuiOwner
    },
    reproveTuiOwner: async ({ owner }) => owner,
    recoverTuiOwner: async () => {
      if (!tuiOwner) {
        throw new Error('scripted TUI owner missing')
      }
      return tuiOwner
    },
    stopRecoveredOwner: async () => {},
    waitForTuiExit: async (owner, persistHandle) => {
      await persistHandle(
        claudeProviderHandleLink({
          sessionId: PROVIDER_SESSION,
          leafUuid: 'tui-assistant',
          resumed: true,
          fence: owner.link.mintedAtFence,
          observedAt: Date.now()
        })
      )
      return { transcriptPath }
    },
    waitForTuiIdleOrExit: async () => 'idle',
    tuiStatus: () => 'idle',
    stopFailedTuiLaunch: async () => {}
  }
  const runtime = {
    getRuntimeId: () => 'runtime-1',
    getStructuredAgentSessionCreateSupport: async () => ({ supported: true }),
    resolveStructuredAgentSessionCreateIntent: async (input: { envelope: unknown }) => ({
      ...ensureParams(1),
      envelope: input.envelope,
      providerHandle: undefined
    }),
    publishStructuredAgentSessionTab: vi.fn(),
    ensureStructuredAgentSessionHost: () =>
      ensureStructuredAgentSessionHost({
        stateDirectory: root,
        hostId: 'local',
        claimKeyId: 'key-1',
        resolveWorkspacePath: async (workspaceId) => `/repos/${workspaceId}`,
        resolveCodexCommand: () => '/usr/local/bin/codex',
        resolveClaudeCommand: () => '/usr/local/bin/claude',
        resolveClaudeLaunchEnv: () => ({
          ANTHROPIC_AUTH_TOKEN: 'configured-token',
          ANTHROPIC_BASE_URL: 'https://gateway.example.test'
        }),
        openClaudeConnection: claude.openConnection,
        handoffTransport
      }).then(() => undefined),
    registerSubscriptionCleanup: (id: string, dispose: () => void) => cleanups.set(id, dispose),
    cleanupSubscription: (id: string) => cleanups.get(id)?.(),
    cleanupSubscriptionsByPrefix: () => {}
  }
  dispatcher = new RpcDispatcher({
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: STRUCTURED_AGENT_SESSION_METHODS
  })
})

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  await rm(root, { recursive: true, force: true })
})

describe('a structured Claude session over agentSession.*', () => {
  it('durably returns actionable sign-in guidance when initialization has no credentials', async () => {
    claude.setInitializeAccount({ apiProvider: 'firstParty', tokenSource: 'none' })
    const params = createIntentParams()

    const first = await call('agentSession.create', params)
    const retry = await call('agentSession.create', params)

    expect(first).toMatchObject({
      ok: true,
      result: {
        ok: false,
        refusal: {
          code: 'agent_session_operation_invalid',
          message: expect.stringMatching(/not signed in.*Claude CLI.*CLAUDE_CONFIG_DIR/s)
        }
      }
    })
    expect((retry as { result: unknown }).result).toEqual((first as { result: unknown }).result)
    expect(claude.connections).toHaveLength(1)
  })

  it('creates, sends, streams, approves, interrupts, and resumes from the chain head', async () => {
    const created = await ok<{ fence: number }>('agentSession.create', createIntentParams())
    expect(claude.live().launch.args).toContain('--session-id')
    expect(claude.live().launch.args).toContain(PROVIDER_SESSION)
    expect(claude.live().launch.env).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'configured-token',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      CLAUDE_CONFIG_DIR: join(root, 'claude-home'),
      [CLAUDE_SPAWN_TOKEN_ENV]: expect.any(String)
    })
    const stream = await subscribe()

    const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'List files' }] }
    const sent = await ok<{
      submission: { dispatchState: string; providerItemId: string | null }
    }>('agentSession.send', {
      envelope: envelope('agentSession.send', { body }, created.fence),
      body
    })
    expect(sent.submission).toMatchObject({
      dispatchState: 'accepted',
      providerItemId: `claude:${PROVIDER_SESSION}:user-1`
    })

    claude.live().handlers.onMessage?.({
      type: 'stream_event',
      session_id: PROVIDER_SESSION,
      uuid: 'assistant-leaf',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Two files.' } }
    })
    claude.live().handlers.onMessage?.({
      type: 'assistant',
      session_id: PROVIDER_SESSION,
      uuid: 'assistant-leaf',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Two files.' }] }
    })
    await getStructuredAgentSessionHost()?.flushStreamedEvents(SESSION)
    expect(itemsOf(stream).find((item) => textOf(item) === 'Two files.')?.itemId).toBe(
      `claude:${PROVIDER_SESSION}:assistant-leaf`
    )

    claude.live().handlers.onControlRequest?.({
      type: 'control_request',
      request_id: 'permission-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        tool_use_id: 'tool-1',
        input: { command: 'ls' }
      }
    })
    await getStructuredAgentSessionHost()?.flushStreamedEvents(SESSION)
    const approval = itemsOf(stream).find((item) => item.body?.kind === 'approval')
    expect(approval?.body).toMatchObject({ title: 'Allow Bash?', detail: '{"command":"ls"}' })
    await ok('agentSession.respondToApproval', {
      envelope: envelope(
        'agentSession.respondTo:approval',
        {
          itemId: approval?.itemId,
          expectedRevision: approval?.revision,
          optionId: 'allow'
        },
        created.fence
      ),
      itemId: approval?.itemId,
      expectedRevision: approval?.revision,
      optionId: 'allow'
    })
    expect(claude.live().replies.at(-1)).toMatchObject({
      requestId: 'permission-1',
      response: { behavior: 'allow', toolUseID: 'tool-1' }
    })

    await expect(
      ok('agentSession.cancel', {
        envelope: envelope('agentSession.cancel', { turnId: 'user-1' }, created.fence),
        turnId: 'user-1'
      })
    ).resolves.toMatchObject({ turnId: 'user-1', cancelled: true })
    expect(claude.live().calls.at(-1)).toMatchObject({ subtype: 'interrupt' })

    const old = claude.live()
    const resumed = await ok<{ fence: number }>('agentSession.ensure', ensureParams(created.fence))
    expect(resumed.fence).toBe(created.fence + 1)
    expect(old.closed).toBe(true)
    expect(claude.live().launch.args.slice(-2)).toEqual(['--resume', PROVIDER_SESSION])
    const host = getStructuredAgentSessionHost() as unknown as {
      deps: { store: { getRecord: (sessionId: string) => { providerHandleChain: unknown[] } } }
    }
    expect(host.deps.store.getRecord(SESSION).providerHandleChain.at(-1)).toMatchObject({
      handle: {
        provider: 'claude',
        sessionId: PROVIDER_SESSION,
        leafUuid: 'assistant-leaf'
      },
      origin: 'resumed'
    })
  })

  it('completes a scripted native to TUI to native cycle with provider-history rehydration', async () => {
    const created = await ok<{ fence: number }>('agentSession.create', createIntentParams())
    await writeFile(
      transcriptPath,
      [
        {
          type: 'user',
          uuid: 'native-user',
          message: { role: 'user', content: [{ type: 'text', text: 'NATIVE_USER' }] }
        },
        {
          type: 'assistant',
          uuid: 'native-assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'NATIVE_ASSISTANT' }] }
        },
        {
          type: 'user',
          uuid: 'tui-user',
          message: { role: 'user', content: [{ type: 'text', text: 'TUI_USER' }] }
        },
        {
          type: 'assistant',
          uuid: 'tui-assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'TUI_ASSISTANT' }] }
        },
        { type: 'last-prompt', leafUuid: 'tui-assistant' }
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')
    )

    await ok('agentSession.requestHandoff', handoffParams('to-tui', created.fence))
    const host = getStructuredAgentSessionHost()!
    await vi.waitFor(async () =>
      expect(await host.handoffStatus(SESSION)).toMatchObject({ owner: 'tui', phase: 'idle' })
    )
    expect(claude.connections[0]?.closed).toBe(true)

    const tuiFence = (
      host as unknown as {
        deps: { store: { getRecord: (id: string) => { lease: { runtimeFence: number } } } }
      }
    ).deps.store.getRecord(SESSION).lease.runtimeFence
    await ok('agentSession.requestHandoff', handoffParams('to-native', tuiFence))
    await vi.waitFor(async () =>
      expect(await host.handoffStatus(SESSION)).toMatchObject({ owner: 'native', phase: 'idle' })
    )

    const frames = await subscribe()
    const texts = itemsOf(frames).map(textOf).filter(Boolean)
    expect(texts).toEqual(
      expect.arrayContaining(['NATIVE_USER', 'NATIVE_ASSISTANT', 'TUI_USER', 'TUI_ASSISTANT'])
    )
    expect(new Set(texts).size).toBe(texts.length)
    expect(claude.connections).toHaveLength(2)
    expect(claude.live().launch.args.slice(-2)).toEqual(['--resume', PROVIDER_SESSION])
    const record = (
      host as unknown as {
        deps: {
          store: {
            getRecord: (id: string) => {
              providerHandleChain: { handle: { provider: string; leafUuid?: string | null } }[]
            }
          }
        }
      }
    ).deps.store.getRecord(SESSION)
    expect(record.providerHandleChain.at(-1)?.handle).toMatchObject({
      provider: 'claude',
      leafUuid: 'tui-assistant'
    })
  })
})
