import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../shared/agent-session-wire'
import {
  AGENT_SESSION_TURN_ITEM_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import { fakeClaude } from './claude-structured-fake-connection-test-fixture'
import { claudeSessionIdForOrcaSession } from '../claude/claude-structured-launch-resolution'
import { CLAUDE_SPAWN_TOKEN_ENV } from '../claude/claude-structured-owner-identity'
import { attachFingerprintFields } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionStatusSink } from '../native-chat/agent-session-wire/structured-agent-session-status-feed'
import type { OrcaRuntimeService } from './orca-runtime'
import type { RpcRequest, RpcResponse } from './rpc/core'
import type { ClaudeStructuredAuthPolicy } from '../claude-accounts/claude-structured-auth-policy'
import { RpcDispatcher } from './rpc/dispatcher'
import type { NativeChatShellEnvironmentPolicy } from '../../shared/native-chat-shell-environment'
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

const { resolveSessionFilePath } = vi.hoisted(() => ({
  resolveSessionFilePath: vi.fn()
}))

vi.mock('../native-chat/session-file-resolver', () => ({
  resolveSessionFilePath
}))

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
    accountHome: { variable: 'CLAUDE_CONFIG_DIR' as const, path: recordAccountHomePath },
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

let claude: ReturnType<typeof fakeClaude>
let root: string
let dispatcher: RpcDispatcher
let cleanups: Map<string, () => void>
let transcriptPath: string
/** The Claude home the durable record pins; the managed dir under `root` unless a test says otherwise. */
let recordAccountHomePath: string
/** Managed-account state and configured overlay this host installs, per test. */
let claudeAuthPolicy: ClaudeStructuredAuthPolicy
let claudeLaunchEnv: Record<string, string>
let shellEnv: NodeJS.ProcessEnv
let shellEnvironmentPolicy: NativeChatShellEnvironmentPolicy
/** What the host handed its status sink as child work. */
let childWork: Parameters<NonNullable<StructuredAgentSessionStatusSink['publishChildWork']>>[]

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

async function subscribe(
  client: { clientKind: 'runtime'; clientCapabilities: string[] } = CLIENT
): Promise<AgentSessionSubscribeEvent[]> {
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
    client
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
  shellEnv = { PATH: '/shell/bin:/usr/bin' }
  shellEnvironmentPolicy = { inheritAll: true, names: [] }
  claudeLaunchEnv = {
    ANTHROPIC_AUTH_TOKEN: 'configured-token',
    ANTHROPIC_BASE_URL: 'https://gateway.example.test'
  }
  root = await mkdtemp(join(tmpdir(), 'orca-claude-structured-integration-'))
  recordAccountHomePath = join(root, 'claude-home')
  transcriptPath = join(root, 'claude-home', 'projects', 'workspace', `${PROVIDER_SESSION}.jsonl`)
  await mkdir(join(root, 'claude-home', 'projects', 'workspace'), { recursive: true })
  resolveSessionFilePath.mockResolvedValue(transcriptPath)
  claude = fakeClaude(PROVIDER_SESSION)
  cleanups = new Map()
  childWork = []
  const runtime = {
    getRuntimeId: () => 'runtime-1',
    getClientSettings: () => ({ experimentalStructuredNativeChat: true }),
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
        // Hermetic: never the developer's real login shell.
        resolveEnvironment: async () => shellEnv,
        resolveShellEnvironmentPolicy: () => shellEnvironmentPolicy,
        resolveClaudeAuthPolicy: () => claudeAuthPolicy,
        openClaudeConnection: claude.openConnection,
        statusSink: {
          publish: () => {},
          forget: () => {},
          publishChildWork: (...args) => childWork.push(args)
        }
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
  it("hands its subagents to the status sink under the session's own address", async () => {
    const created = await ok<{ fence: number }>('agentSession.create', createIntentParams())
    const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Audit it' }] }
    await ok('agentSession.send', {
      envelope: envelope('agentSession.send', { body }, created.fence),
      body
    })
    claude.live().handlers.onMessage?.({
      type: 'system',
      subtype: 'task_started',
      session_id: PROVIDER_SESSION,
      uuid: 'task-start',
      task_id: 'agent-1',
      tool_use_id: 'toolu_1',
      task_type: 'local_agent',
      description: 'Audit the build',
      is_backgrounded: true
    })
    expect(childWork).toContainEqual([
      expect.objectContaining({ kind: 'structured-session', sessionId: SESSION }),
      [
        expect.objectContaining({
          type: 'live',
          child: expect.objectContaining({
            handle: { idKind: 'task_id', id: 'agent-1', runId: 'toolu_1' },
            description: 'Audit the build'
          })
        })
      ],
      'claude'
    ])
  })

  it('strips ambient Anthropic auth from the child once a managed account is pinned', async () => {
    claudeAuthPolicy = { stripAuthEnv: true }
    claudeLaunchEnv = { ANTHROPIC_BASE_URL: 'https://gateway.example.test' }
    shellEnv = {
      ...shellEnv,
      ANTHROPIC_API_KEY: 'sk-ant-SHELL-LEAK',
      ANTHROPIC_AUTH_TOKEN: 'tok-SHELL-LEAK',
      CLAUDE_CONFIG_DIR: '/shell/claude'
    }

    await ok<{ fence: number }>('agentSession.create', createIntentParams())

    const env = claude.live().launch.env
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      CLAUDE_CONFIG_DIR: join(root, 'claude-home')
    })
  })

  it('passes shell exports straight to the child, as a terminal would', async () => {
    shellEnv = {
      ...shellEnv,
      CODEX_LB_API_KEY: 'shell-exported',
      ANTHROPIC_API_KEY: 'sk-ant-SHELL-ONLY'
    }

    await ok<{ fence: number }>('agentSession.create', createIntentParams())

    expect(claude.live().launch.env).toMatchObject({
      CODEX_LB_API_KEY: 'shell-exported',
      ANTHROPIC_API_KEY: 'sk-ant-SHELL-ONLY'
    })
  })

  it('ignores a shell-exported CLAUDE_CONFIG_DIR: the pinned account chooses the Claude home', async () => {
    // System auth on the CLI's own default home: an explicit pin to it would move the CLI off its
    // default Keychain item, so the child must carry no CLAUDE_CONFIG_DIR at all.
    recordAccountHomePath = join(homedir(), '.claude')
    shellEnv = { ...shellEnv, CLAUDE_CONFIG_DIR: '/shell/claude', SHELL_ONLY_MARKER: 'from-shell' }

    await ok<{ fence: number }>('agentSession.create', createIntentParams())

    const env = claude.live().launch.env
    expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    expect(env?.SHELL_ONLY_MARKER).toBe('from-shell')
  })

  it('leaves unlisted shell exports out when inheritance is off', async () => {
    shellEnv = { ...shellEnv, CODEX_LB_API_KEY: 'shell-exported', LISTED_ONLY: 'yes' }
    shellEnvironmentPolicy = { inheritAll: false, names: ['LISTED_ONLY'] }

    await ok<{ fence: number }>('agentSession.create', createIntentParams())

    const env = claude.live().launch.env
    expect(env?.LISTED_ONLY).toBe('yes')
    expect(env).not.toHaveProperty('CODEX_LB_API_KEY')
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

  it('publishes, then ends the session with sign-in guidance when initialization has no credentials', async () => {
    claude.setInitializeAccount({ apiProvider: 'firstParty', tokenSource: 'none' })

    // The create answers once the child is spawned; the missing credentials arrive after.
    await ok<{ fence: number }>('agentSession.create', createIntentParams())
    await waitForStructuredAgentSessionRecovery()

    const guidance = itemsOf(await subscribe()).find((item) => item.body?.kind === 'status')
    expect(guidance?.body).toMatchObject({
      kind: 'status',
      text: expect.stringMatching(
        /stopped before it finished starting: .*not signed in.*Claude CLI.*CLAUDE_CONFIG_DIR/s
      )
    })
    expect(leaseOf(SESSION)).toMatchObject({ claimStatus: 'released', handoffStage: null })
    // A failed start is not auto-resumed into the same failure.
    expect(claude.connections).toHaveLength(1)
  })

  // The root's death is first-hand. Its descendants were never snapshottable, or one was seen
  // alive; either way the root was the only writer, so the reservation goes with it.
  it.each(['unverifiable', 'live'] as const)(
    'releases a session whose CLI self-exited during create with its tree %s, with its diagnostic intact',
    async (tree) => {
      claude.setSelfExit({
        message: 'claude stream-json exited (code 1): claude: not signed in',
        exitVerdict: { root: 'exited', tree }
      })

      const failed = await call('agentSession.create', createIntentParams())

      // Answered once, as the refusal a replay of this operation gives, never thrown first.
      expect(failed).toMatchObject({
        ok: true,
        result: {
          ok: false,
          refusal: {
            code: 'agent_session_operation_invalid',
            message: expect.stringContaining('claude: not signed in'),
            ownerVerdict: 'exited'
          }
        }
      })
      const lease = leaseOf(SESSION)
      // Latching here would refuse every later attach with agent_session_ownership_unknown,
      // wedging a user who only needs to sign in.
      expect(lease).toMatchObject({ claimStatus: 'released', handoffStage: null })
      expect(lease.deathEvidence).toMatchObject({
        kind: 'exit-observed',
        detail: 'the provider process exited; its descendants were not proven gone'
      })

      claude.setSelfExit(null)
      // Signing in and reopening the chat works: the reservation was not latched.
      await ok<{ fence: number }>('agentSession.ensure', ensureParams(lease.runtimeFence))
    }
  )

  it('answers a create whose whole CLI tree exited as exited on the first call', async () => {
    claude.setSelfExit({
      message: 'claude stream-json exited (code 1): claude: not signed in',
      // The common case: the close ladder proves the root and every descendant gone.
      exitVerdict: { root: 'exited', tree: 'exited' }
    })

    const failed = await call('agentSession.create', createIntentParams())

    expect(failed).toMatchObject({
      ok: true,
      result: {
        ok: false,
        refusal: {
          code: 'agent_session_operation_invalid',
          message: expect.stringContaining('claude: not signed in'),
          ownerVerdict: 'exited'
        }
      }
    })
    expect(leaseOf(SESSION)).toMatchObject({ claimStatus: 'released', handoffStage: null })
    claude.setSelfExit(null)
  })

  it.each(['unverifiable', 'live'] as const)(
    'reopens a chat whose stop saw the Claude root exit with its tree %s',
    async (tree) => {
      await ok('agentSession.create', createIntentParams())
      const first = claude.live()
      first.exitVerdict = { root: 'exited', tree }
      first.close = async () => {
        first.closed = true
        return false
      }
      const host = getStructuredAgentSessionHost()
      // The idle release clock's eviction: the lease follows the root, so the host lets go.
      await host?.close(SESSION)
      expect(host?.hasSession(SESSION)).toBe(false)

      // What the chat surface's `agentSession.hold` does when the user comes back to it.
      await host?.hold(SESSION, 'desktop-chat:reopen')

      expect(claude.connections).toHaveLength(2)
      expect(host?.hasSession(SESSION)).toBe(true)
    }
  )

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

  // A descendant seen alive is one that survived the close ladder, such as an MCP server that
  // ignores SIGTERM; it no longer holds the chat.
  it.each(['unverifiable', 'live'] as const)(
    'restarts an open chat after a Claude crash whose tree was %s',
    async (tree) => {
      const created = await ok<{ fence: number }>('agentSession.create', createIntentParams())
      // The open chat surface is what asks the host to bring Claude back.
      await getStructuredAgentSessionHost()?.hold(SESSION, 'desktop-chat:open')
      const connection = claude.live()
      connection.exitVerdict = { root: 'exited', tree }
      connection.close = async () => {
        connection.closed = true
        return false
      }
      // Claude takes the message but crashes before echoing it.
      connection.send = async (message) => {
        connection.sent.push(message)
      }
      const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'in flight' }] }
      const inFlight = ok<{ submission: { dispatchState: string; reason: string | null } }>(
        'agentSession.send',
        { envelope: envelope('agentSession.send', { body }, created.fence), body }
      )
      await vi.waitFor(() => expect(connection.sent).toHaveLength(1))
      connection.handlers.onExit?.(new Error('claude stream-json exited (code 1): crashed'))

      expect((await inFlight).submission).toMatchObject({
        dispatchState: 'unknown',
        reason: 'provider_exited_before_acknowledgement'
      })
      // Held back, sends failed with the crash until the idle clock stopped the chat.
      await waitForStructuredAgentSessionRecovery()
      expect(claude.connections).toHaveLength(2)
      expect(claude.live().launch.options).toMatchObject({ resume: PROVIDER_SESSION })
      const lease = leaseOf(SESSION)
      expect(lease).toMatchObject({ claimStatus: 'live', handoffStage: null })
      const next = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'after' }] }
      const sent = await ok<{ submission: { dispatchState: string } }>('agentSession.send', {
        envelope: envelope('agentSession.send', { body: next }, lease.runtimeFence),
        body: next
      })
      expect(sent.submission.dispatchState).toBe('accepted')
      expect(claude.live().sent).toHaveLength(1)
    }
  )

  it('creates, sends, streams, approves, interrupts, and resumes from the chain head', async () => {
    shellEnv = { ...shellEnv, ANTHROPIC_API_KEY: 'sk-ant-SHELL-LEAK' }
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

    // A background task can wake Claude after the preceding dispatch settled.
    // This assistant frame opens the provider-owned turn without an Orca send
    // echo; Stop must target that frame's id rather than the settled user row.
    claude.live().handlers.onMessage?.({
      type: 'assistant',
      session_id: PROVIDER_SESSION,
      uuid: 'provider-opened-assistant',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Background task update.' }] }
    })
    await getStructuredAgentSessionHost()?.flushStreamedEvents(SESSION)

    claude.live().handlers.onMessage?.({
      type: 'system',
      subtype: 'background_tasks_changed',
      session_id: PROVIDER_SESSION,
      uuid: 'background-roster',
      tasks: [
        { task_id: 'task-one', task_type: 'local_agent', description: 'First task' },
        { task_id: 'task-two', task_type: 'local_bash', description: 'Second task' }
      ]
    })
    const itemsBeforeTaskStop = itemsOf(stream)
    const targetedStopFields = {
      turnId: 'background-tasks',
      scope: 'background-tasks',
      taskId: 'task-two'
    }
    await expect(
      ok('agentSession.cancel', {
        envelope: envelope('agentSession.cancel', targetedStopFields, created.fence),
        ...targetedStopFields
      })
    ).resolves.toMatchObject({ turnId: 'background-tasks', cancelled: true })
    expect(claude.live().calls.filter((entry) => entry.subtype === 'stop_task')).toEqual([
      { subtype: 'stop_task', params: { taskId: 'task-two' } }
    ])
    expect(itemsOf(stream)).toEqual(itemsBeforeTaskStop)

    const staleStopFields = {
      turnId: 'background-tasks',
      scope: 'background-tasks',
      taskId: 'task-stale'
    }
    await expect(
      ok('agentSession.cancel', {
        envelope: envelope('agentSession.cancel', staleStopFields, created.fence),
        ...staleStopFields
      })
    ).resolves.toMatchObject({ turnId: 'background-tasks', cancelled: false })
    expect(claude.live().calls.filter((entry) => entry.subtype === 'stop_task')).toHaveLength(1)

    const answeredPermission = Promise.resolve(
      claude.live().handlers.canUseTool?.('Bash', { command: 'ls' }, {
        requestId: 'permission-1',
        toolUseID: 'tool-1',
        signal: new AbortController().signal
      } as never)
    )
    await getStructuredAgentSessionHost()?.flushStreamedEvents(SESSION)
    const approval = itemsOf(stream).find((item) => item.body?.kind === 'approval')
    expect(approval?.body).toMatchObject({
      title: 'Allow Bash?',
      detail: '{\n  "command": "ls"\n}'
    })
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
        envelope: envelope(
          'agentSession.cancel',
          { turnId: 'provider-opened-assistant' },
          created.fence
        ),
        turnId: 'provider-opened-assistant'
      })
    ).resolves.toMatchObject({ turnId: 'provider-opened-assistant', cancelled: true })
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
    // A completed turn advances the durable resume point in place while the owner is live.
    expect(host.deps.store.getRecord(SESSION).providerHandleChain.at(-1)?.handle).toMatchObject({
      provider: 'claude',
      leafUuid: 'assistant-leaf'
    })
    const old = claude.live()
    const resumed = await ok<{ fence: number }>('agentSession.ensure', ensureParams(created.fence))
    expect(resumed.fence).toBe(created.fence + 1)
    expect(old.closed).toBe(true)
    // Claude owns where the conversation continues; the stored leaf is the last completed turn.
    expect(claude.live().launch.options).toMatchObject({ resume: PROVIDER_SESSION })
    expect(claude.live().launch.options).not.toHaveProperty('resumeSessionAt')
    const lastCompletedTurn = {
      handle: { provider: 'claude', sessionId: PROVIDER_SESSION, leafUuid: 'assistant-leaf' },
      origin: 'resumed'
    }
    expect(host.deps.store.getRecord(SESSION).providerHandleChain.at(-1)).toMatchObject(
      lastCompletedTurn
    )
    // Open, close, open with no turn in between keeps that leaf.
    const reopened = await ok<{ fence: number }>('agentSession.ensure', ensureParams(resumed.fence))
    expect(reopened.fence).toBe(resumed.fence + 1)
    expect(host.deps.store.getRecord(SESSION).providerHandleChain.at(-1)).toMatchObject(
      lastCompletedTurn
    )
  })

  it('delivers the breakdown a settled turn asks for with no later frame to carry it', async () => {
    const answers: ((value: unknown) => void)[] = []
    claude.setContextUsage(() => new Promise((resolve) => answers.push(resolve)))
    const created = await ok<{ fence: number }>('agentSession.create', createIntentParams())
    const stream = await subscribe({
      ...CLIENT,
      clientCapabilities: [...CLIENT.clientCapabilities, AGENT_SESSION_TURN_ITEM_CAPABILITY]
    })
    const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Hi' }] }
    await ok('agentSession.send', {
      envelope: envelope('agentSession.send', { body }, created.fence),
      body
    })
    claude.live().handlers.onMessage?.({
      type: 'result',
      subtype: 'success',
      session_id: PROVIDER_SESSION,
      uuid: 'result-frame-uuid'
    })
    await getStructuredAgentSessionHost()?.flushStreamedEvents(SESSION)
    const turnRow = () => itemsOf(stream).find((item) => item.body?.kind === 'turn')
    expect(turnRow()?.body).toMatchObject({ state: 'completed' })

    answers.at(-1)?.({
      model: 'claude-sonnet-5',
      totalTokens: 18_600,
      rawMaxTokens: 200_000,
      categories: [{ name: 'Messages', tokens: 12_000 }]
    })
    // The answer is the last event of the turn: only its own publication can reach the client.
    await vi.waitFor(async () => {
      await getStructuredAgentSessionHost()?.flushStreamedEvents(SESSION)
      const turn = turnRow()?.body
      expect(turn?.kind === 'turn' ? turn.contextUsage?.used : undefined).toMatchObject({
        kind: 'report',
        usedTokens: 18_600,
        categories: [{ name: 'Messages', tokens: 12_000 }]
      })
    })
  })
})
