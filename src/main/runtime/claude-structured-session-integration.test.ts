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
import type { ClaudeStructuredAuthPolicy } from '../claude-accounts/claude-structured-auth-policy'
import { RpcDispatcher } from './rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from './rpc/methods/structured-agent-session'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime,
  waitForStructuredAgentSessionRecovery
} from './structured-agent-session-runtime'

const SESSION = 'claude-integration-1'
const PROVIDER_SESSION = claudeSessionIdForOrcaSession(SESSION)
const WORKSPACE = 'workspace-claude'
// Why 'runtime': this file exercises the Claude structured integration over agentSession.*, not the
// mobile surface — nothing here asserts anything mobile-specific, and its sibling integration
// suites use 'runtime' too. Mobile additionally requires the experimental structured-chat setting,
// which structured-agent-session.test.ts pins in both its satisfied and refused states.
const CLIENT = {
  clientKind: 'runtime' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
}

const { readClaudeTranscriptLeafUuid, resolveSessionFilePath } = vi.hoisted(() => ({
  readClaudeTranscriptLeafUuid: vi.fn(),
  resolveSessionFilePath: vi.fn()
}))

vi.mock('../native-chat/session-file-resolver', () => ({
  readClaudeTranscriptLeafUuid,
  resolveSessionFilePath
}))

type FakeClaudeConnection = Omit<ClaudeStreamJsonConnection, 'closed' | 'exitVerdict'> & {
  closed: boolean
  exitVerdict: ClaudeStreamJsonConnection['exitVerdict']
  launch: ClaudeStreamJsonLaunch
  handlers: ClaudeStreamJsonConnectionHandlers
  calls: { subtype: string; params?: Record<string, unknown> }[]
  sent: Record<string, unknown>[]
}

function fakeClaude() {
  const connections: FakeClaudeConnection[] = []
  let initializeAccount: unknown
  /** A child that dies during start, with the close verdict its ladder observed. */
  let selfExit: { message: string; exitVerdict: ClaudeStreamJsonConnection['exitVerdict'] } | null =
    null
  const openConnection = (async (launch, handlers = {}) => {
    const connection: FakeClaudeConnection = {
      launch,
      handlers,
      calls: [],
      sent: [],
      pid: 4321 + connections.length,
      closed: false,
      initializationResult: async () => {
        connection.calls.push({ subtype: 'initialize' })
        if (selfExit) {
          handlers.onExit?.(new Error(selfExit.message))
          return { models: [] }
        }
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
      },
      getSettings: async () => {
        connection.calls.push({ subtype: 'get_settings' })
        return { env: {} }
      },
      supportedModels: async () => {
        connection.calls.push({ subtype: 'list_models' })
        return [{ value: 'sonnet', displayName: 'Sonnet' }]
      },
      setModel: async (model) => {
        connection.calls.push({ subtype: 'set_model', params: { model } })
      },
      setPermissionMode: async (mode) => {
        connection.calls.push({ subtype: 'set_permission_mode', params: { mode } })
      },
      applyFlagSettings: async (settings) => {
        connection.calls.push({ subtype: 'apply_flag_settings', params: { settings } })
      },
      interrupt: async () => {
        connection.calls.push({ subtype: 'interrupt', params: {} })
        return undefined
      },
      cancelAsyncMessage: async () => {},
      stopTask: async (taskId) => {
        connection.calls.push({ subtype: 'stop_task', params: { taskId } })
      },
      send: async (message) => {
        connection.sent.push(message)
        if (message.type === 'user') {
          handlers.onMessage?.({ ...message, uuid: 'user-1' })
        }
      },
      exitVerdict: selfExit?.exitVerdict ?? { root: 'live', tree: 'unverifiable' },
      close: async () => {
        connection.closed = true
        return selfExit === null
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
    },
    setSelfExit: (exit: typeof selfExit) => {
      selfExit = exit
    }
  }
}

let operations = 0
// Keep IDs unique without making each assertion depend on a wall-clock tick.
const TEST_OPERATION_TIMESTAMP = Date.now().toString()

function operationId(): string {
  operations += 1
  return `${TEST_OPERATION_TIMESTAMP}-${operations.toString(16).padStart(32, '0')}`
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

function leaseOf(sessionId: string): {
  claimStatus: string
  runtimeFence: number
  handoffStage: string | null
  deathEvidence: { kind: string; detail: string } | null
} {
  const host = getStructuredAgentSessionHost() as unknown as {
    deps: { store: { getRecord: (id: string) => { lease: ReturnType<typeof leaseOf> } } }
  }
  return host.deps.store.getRecord(sessionId).lease
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
/** Managed-account state and configured overlay this host installs, per test. */
let claudeAuthPolicy: ClaudeStructuredAuthPolicy
let claudeLaunchEnv: Record<string, string>

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
        ? frame.page.items
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
  claudeAuthPolicy = { stripAuthEnv: false }
  claudeLaunchEnv = {
    ANTHROPIC_AUTH_TOKEN: 'configured-token',
    ANTHROPIC_BASE_URL: 'https://gateway.example.test'
  }
  root = await mkdtemp(join(tmpdir(), 'orca-claude-structured-integration-'))
  transcriptPath = join(root, 'claude-home', 'projects', 'workspace', `${PROVIDER_SESSION}.jsonl`)
  await mkdir(join(root, 'claude-home', 'projects', 'workspace'), { recursive: true })
  resolveSessionFilePath.mockResolvedValue(transcriptPath)
  // The production branch proof returns the latest descendant of the prior
  // cursor; mirror that contract so structured close does not regress to a
  // stale mocked head.
  readClaudeTranscriptLeafUuid.mockImplementation(
    async (_path: string, _providerSessionId: string, previousLeafUuid?: string | null) =>
      previousLeafUuid ?? 'init-leaf'
  )
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
          observedAt: 1
        }),
        transcriptPath
      }
      return tuiOwner
    },
    reproveTuiOwner: async ({ owner }) => {
      if (owner.link.handle.provider !== 'claude' || !owner.transcriptPath) {
        return owner
      }
      return {
        ...owner,
        link: claudeProviderHandleLink({
          sessionId: owner.link.handle.sessionId,
          leafUuid: await readClaudeTranscriptLeafUuid(owner.transcriptPath),
          resumed: true,
          fence: owner.link.mintedAtFence,
          observedAt: 1
        })
      }
    },
    recoverTuiOwner: async () => {
      if (!tuiOwner) {
        throw new Error('scripted TUI owner missing')
      }
      return tuiOwner
    },
    stopRecoveredOwner: async () => {},
    waitForTuiExit: async (owner) => ({ transcriptPath: owner.transcriptPath }),
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
        readProcessStartTime: async (pid: number) => pid * 10,
        resolveClaudeLaunchEnv: () => claudeLaunchEnv,
        resolveClaudeAuthPolicy: () => claudeAuthPolicy,
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
  vi.unstubAllEnvs()
  await stopStructuredAgentSessionRuntime()
  await rm(root, { recursive: true, force: true })
})

describe('a structured Claude session over agentSession.*', () => {
  it('strips ambient Anthropic auth from the child once a managed account is pinned', async () => {
    claudeAuthPolicy = { stripAuthEnv: true }
    claudeLaunchEnv = { ANTHROPIC_BASE_URL: 'https://gateway.example.test' }
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-SHELL-LEAK')
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'tok-SHELL-LEAK')

    await ok<{ fence: number }>('agentSession.create', createIntentParams())

    const env = claude.live().launch.env
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      CLAUDE_CONFIG_DIR: join(root, 'claude-home')
    })
  })

  it('refuses a create whose configured env overrides the pinned managed account auth', async () => {
    claudeAuthPolicy = { stripAuthEnv: true }
    // The default overlay carries ANTHROPIC_AUTH_TOKEN, which the terminal path
    // refuses at spawn-env.ts:25 rather than letting it beat the pinned account.
    const refused = await call('agentSession.create', createIntentParams())

    expect(JSON.stringify(refused)).toContain('explicit Anthropic auth environment')
    // Refused before spawn: no provider child was ever opened.
    expect(claude.connections).toHaveLength(0)
  })

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

  it('releases a session whose CLI self-exited during create, with its diagnostic intact', async () => {
    claude.setSelfExit({
      message: 'claude stream-json exited (code 1): claude: not signed in',
      // The root's death is first-hand; its descendants were never snapshottable.
      exitVerdict: { root: 'exited', tree: 'unverifiable' }
    })

    const failed = await call('agentSession.create', createIntentParams())

    expect(JSON.stringify(failed)).toContain('claude: not signed in')
    const lease = leaseOf(SESSION)
    // Latching here would refuse every later attach with agent_session_ownership_unknown,
    // wedging a user who only needs to sign in.
    expect(lease).toMatchObject({ claimStatus: 'released', handoffStage: null })
    expect(lease.deathEvidence).toMatchObject({
      kind: 'exit-observed',
      detail: 'the provider process exited; its descendants were not verifiable'
    })

    claude.setSelfExit(null)
    // Signing in and reopening the chat works: the reservation was not latched.
    await ok<{ fence: number }>('agentSession.ensure', ensureParams(lease.runtimeFence))
  })

  it('keeps a session reserved when a descendant of the failed start was seen alive', async () => {
    claude.setSelfExit({
      message: 'claude stream-json exited (code 1): claude: not signed in',
      exitVerdict: { root: 'exited', tree: 'live' }
    })

    await call('agentSession.create', createIntentParams())

    // A live descendant still holds the provider session: releasing would hand a
    // second writer to it.
    expect(leaseOf(SESSION)).toMatchObject({
      claimStatus: 'reserved',
      handoffStage: 'manual-recovery'
    })
    claude.setSelfExit(null)
  })

  it('routes a published Claude first-hand exit through fenced host reconciliation', async () => {
    await ok<{ fence: number }>('agentSession.create', createIntentParams())
    const connection = claude.live()
    connection.exitVerdict = { root: 'exited', tree: 'unverifiable' }
    connection.handlers.onExit?.(new Error('claude stream-json exited (code 1): crashed'))

    // Claude publishes an exit only after its close ladder and transcript write,
    // so the recovery barrier — not a wall-clock poll — is what says it landed.
    await waitForStructuredAgentSessionRecovery()
    expect(leaseOf(SESSION)).toMatchObject({ claimStatus: 'released', handoffStage: null })
  })

  it('creates, sends, streams, approves, interrupts, and resumes from the chain head', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-SHELL-LEAK')
    const created = await ok<{ fence: number }>('agentSession.create', createIntentParams())
    expect(claude.live().launch.options).toMatchObject({ sessionId: PROVIDER_SESSION })
    expect(claude.live().launch.options.resume).toBeUndefined()
    expect(claude.live().launch.env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: 'configured-token',
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      CLAUDE_CONFIG_DIR: join(root, 'claude-home'),
      [CLAUDE_SPAWN_TOKEN_ENV]: expect.any(String)
    })
    // System auth: the user's own shell key is their sign-in, exactly as on the
    // terminal path, and the configured overlay still wins over it.
    expect(claude.live().launch.env).toMatchObject({ ANTHROPIC_API_KEY: 'sk-ant-SHELL-LEAK' })
    expect(claude.live().launch.env?.PATH ?? claude.live().launch.env?.Path).toBeTruthy()
    const history = await call('agentSession.history', {
      sessionId: SESSION,
      direction: 'tail',
      limit: 1
    })
    expect(history).toMatchObject({
      ok: true,
      result: { providerSession: { key: 'session_id', id: PROVIDER_SESSION } }
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
    claude.live().handlers.onMessage?.({
      type: 'result',
      subtype: 'success',
      session_id: PROVIDER_SESSION,
      uuid: 'result-frame-uuid'
    })
    claude.live().handlers.onMessage?.({
      type: 'stream_event',
      session_id: PROVIDER_SESSION,
      uuid: 'stream-event-frame-uuid',
      event: { type: 'message_stop' }
    })
    await getStructuredAgentSessionHost()?.flushStreamedEvents(SESSION)
    expect(itemsOf(stream).find((item) => textOf(item) === 'Two files.')?.itemId).toBe(
      `claude:${PROVIDER_SESSION}:assistant-leaf`
    )

    const answeredPermission = Promise.resolve(
      claude.live().handlers.canUseTool?.('Bash', { command: 'ls' }, {
        requestId: 'permission-1',
        toolUseID: 'tool-1',
        signal: new AbortController().signal
      } as never)
    )
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
    // Answering resolves the SDK's own canUseTool callback with the allow decision.
    await expect(answeredPermission).resolves.toMatchObject({
      behavior: 'allow',
      toolUseID: 'tool-1'
    })

    await expect(
      ok('agentSession.cancel', {
        envelope: envelope('agentSession.cancel', { turnId: 'user-1' }, created.fence),
        turnId: 'user-1'
      })
    ).resolves.toMatchObject({ turnId: 'user-1', cancelled: true })
    expect(claude.live().calls.at(-1)).toMatchObject({ subtype: 'interrupt' })

    const host = getStructuredAgentSessionHost() as unknown as {
      deps: {
        store: {
          getRecord: (sessionId: string) => {
            providerHandleChain: { handle: { provider: string; leafUuid?: string | null } }[]
          }
        }
      }
    }
    expect(host.deps.store.getRecord(SESSION).providerHandleChain.at(-1)?.handle).toMatchObject({
      provider: 'claude',
      leafUuid: null
    })
    const old = claude.live()
    const resumed = await ok<{ fence: number }>('agentSession.ensure', ensureParams(created.fence))
    expect(resumed.fence).toBe(created.fence + 1)
    expect(old.closed).toBe(true)
    expect(resolveSessionFilePath).toHaveBeenCalledWith('claude', PROVIDER_SESSION, {
      claudeProjectsDir: join(root, 'claude-home', 'projects')
    })
    expect(claude.live().launch.options).toMatchObject({
      resume: PROVIDER_SESSION,
      resumeSessionAt: 'assistant-leaf'
    })
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
    // No poll: the request enqueues the flow on the session's serialized chain before it returns,
    // so this status read is already ordered behind it. Polling only added a wall-clock deadline
    // that a loaded runner missed, abandoning a live flow into the suite's teardown.
    expect(await host.handoffStatus(SESSION)).toMatchObject({ owner: 'tui', phase: 'idle' })
    expect(claude.connections[0]?.closed).toBe(true)

    const tuiFence = (
      host as unknown as {
        deps: { store: { getRecord: (id: string) => { lease: { runtimeFence: number } } } }
      }
    ).deps.store.getRecord(SESSION).lease.runtimeFence
    readClaudeTranscriptLeafUuid.mockResolvedValueOnce('tui-assistant')
    await ok('agentSession.requestHandoff', handoffParams('to-native', tuiFence))
    expect(await host.handoffStatus(SESSION)).toMatchObject({ owner: 'native', phase: 'idle' })

    const frames = await subscribe()
    const texts = itemsOf(frames).map(textOf).filter(Boolean)
    expect(texts).toEqual(
      expect.arrayContaining(['NATIVE_USER', 'NATIVE_ASSISTANT', 'TUI_USER', 'TUI_ASSISTANT'])
    )
    expect(new Set(texts).size).toBe(texts.length)
    expect(claude.connections).toHaveLength(2)
    expect(claude.live().launch.options).toMatchObject({ resume: PROVIDER_SESSION })
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
