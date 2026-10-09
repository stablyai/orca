import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import type { AgentChatPermissionMode } from '../../shared/agent-chat-permission-mode'
import type { ChatPermissionCreationHost } from '../../shared/chat-permission-creation.test-fixture'
import type { AgentSessionSubscribeEvent } from '../../shared/agent-session-wire'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { Store } from '../persistence'
import { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'
import { registerSettingsHandlers } from '../ipc/settings'
import { OrcaRuntimeService } from './orca-runtime'
import { RpcDispatcher } from './rpc/dispatcher'
import type { RpcResponse } from './rpc/core'
import { CLIENT_UI_METHODS } from './rpc/methods/client-ui'
import { STRUCTURED_AGENT_SESSION_METHODS } from './rpc/methods/structured-agent-session'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { fakeClaude } from '../claude/claude-structured-session-test-support'
import { fakeCodex, THREAD_ID } from '../codex/codex-structured-session-adapter-fixture'
import { CodexAppServerRequestError } from '../codex/codex-app-server-connection'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { openAgentSessionRecordStoreOnce } from './agent-session-record-store-slot'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && key in value
    ? Object.entries(value).find(([name]) => name === key)?.[1]
    : undefined
}

/** Providers that cannot run Auto: a Claude model without auto support, and a Codex too old for
 *  `approvalsReviewer`. Each narrows a chat's Auto to Ask when it starts. */
function providersWithoutAuto() {
  const models = [{ value: 'default', displayName: 'Default', supportsAutoMode: false }]
  return {
    claude: fakeClaude({
      initProof: 'none',
      replayUuid: null,
      initModels: models,
      routes: { list_models: () => models }
    }),
    codex: fakeCodex({
      'thread/start': (params) => {
        if (params && 'approvalsReviewer' in params) {
          throw new CodexAppServerRequestError(
            'thread/start',
            -32602,
            'unknown parameter approvalsReviewer'
          )
        }
        return { thread: { id: THREAD_ID }, model: 'gpt-live', approvalsReviewer: 'user' }
      }
    })
  }
}

/** Holds each provider's start answer, Codex's `thread/start` and Claude's initialize, until
 *  `release`: the agent is still starting while the chat is already open. */
function holdStarts(providers: ReturnType<typeof providersWithoutAuto>) {
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const codexStart = providers.codex.routes['thread/start']
  providers.codex.routes['thread/start'] = async (params) => {
    await gate
    return codexStart?.(params)
  }
  const openClaude = providers.claude.openConnection
  const openConnection: typeof openClaude = async (...args) => {
    const connection = await openClaude(...args)
    const initialize = connection.initializationResult
    connection.initializationResult = async () => {
      await gate
      return initialize()
    }
    return connection
  }
  return { claude: { ...providers.claude, openConnection }, codex: providers.codex, release }
}

export async function openChatPermissionCreationHost(
  initial: AgentChatPermissionMode,
  options: { withoutAuto?: boolean; heldStart?: boolean } = {}
): Promise<ChatPermissionCreationHost> {
  const root = await mkdtemp(join(tmpdir(), 'orca-chat-default-creation-'))
  const state = getDefaultPersistedState(root)
  state.settings.nativeChatPermissionMode = initial
  state.settings.experimentalNativeChat = true
  state.settings.agentStatusHooksEnabled = false
  state.settings.agentWorkspaceTrustEnabled = false
  state.settings.agentDefaultEnv = {
    claude: { CLAUDE_CONFIG_DIR: join(root, 'claude-home') },
    codex: { CODEX_HOME: join(root, 'codex-home') }
  }
  const authority = new ProfileStateSqliteAuthority(join(root, 'profile-state.db'), 'test')
  authority.writeSerializedState(Buffer.from(JSON.stringify(state)))
  const store = new Store({
    dataFile: join(root, 'orca-data.json'),
    profileStateAuthority: authority
  })
  registerSettingsHandlers(store)
  const runtime = new OrcaRuntimeService(store, undefined, {
    prepareCodexStructuredLaunch: () => join(root, 'codex-home')
  })
  vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({ supported: true })
  Object.assign(runtime, {
    resolveStructuredAgentSessionLocation: async () => ({
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    }),
    resolveRuntimeFileTarget: async () => ({ worktree: { id: 'workspace-1', path: root } })
  })
  const providers = options.withoutAuto
    ? providersWithoutAuto()
    : { claude: fakeClaude({ initProof: 'none', replayUuid: null }), codex: fakeCodex() }
  const { claude, codex, release } = options.heldStart
    ? holdStarts(providers)
    : { ...providers, release: () => {} }
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockImplementation(async () => {
    await ensureStructuredAgentSessionHost({
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'test-key',
      logger: recordingStructuredAgentSessionLogger().logger,
      resolveWorkspacePath: async () => root,
      resolveClaudeCommand: () => 'FORBIDDEN_REAL_PROVIDER',
      resolveCodexCommand: () => 'FORBIDDEN_REAL_PROVIDER',
      resolveLaunchArgs: () => [],
      resolveClaudeAuthPolicy: () => ({ stripAuthEnv: false }),
      openClaudeConnection: claude.openConnection,
      openCodexConnection: codex.openConnection,
      readProcessStartTime: async () => 1
    })
  })
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: [...CLIENT_UI_METHODS, ...STRUCTURED_AGENT_SESSION_METHODS]
  })
  let sequence = 0
  return {
    settings: () => store.getSettings(),
    starts: () => claude.connections.length + codex.connections.length,
    releaseStart: release,
    snapshot: async (sessionId) => {
      const host = getStructuredAgentSessionHost()
      if (!host) {
        throw new Error('No structured host')
      }
      const frames: AgentSessionSubscribeEvent[] = []
      await host.subscribe({
        id: 'snapshot-reader',
        sessionId,
        emit: (event) => frames.push(event)
      })
      host.unsubscribe(sessionId, 'snapshot-reader')
      const frame = frames.find((event) => event.type === 'snapshot')
      if (!frame) {
        throw new Error('No snapshot')
      }
      return frame
    },
    inventory: async () => [await runtime.listMobileSessionTabs('id:workspace-1')],
    subscribeStatus: async (emit) => {
      await runtime.ensureStructuredAgentSessionHost()
      const host = getStructuredAgentSessionHost()
      if (!host) {
        throw new Error('No structured host')
      }
      return { unsubscribe: host.subscribeStatus({ id: 'renderer', emit }) }
    },
    rpc: async (method, params) => {
      const replies: RpcResponse[] = []
      await dispatcher.dispatchStreaming(
        { id: String(++sequence), authToken: 'test', method, params },
        (raw) => replies.push(JSON.parse(raw)),
        {
          clientId: 'test',
          clientKind: 'runtime',
          clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
        }
      )
      const response = replies[0]
      if (!response?.ok) {
        throw new Error(JSON.stringify(response))
      }
      return response.result
    },
    savedSetting: async () => {
      await store.flushPendingOrThrowAsync()
      const saved: unknown = JSON.parse(authority.readSerializedState() ?? '{}')
      return field(field(saved, 'settings'), 'nativeChatPermissionMode')
    },
    savedMode: async (sessionId) => {
      const { journalDatabase } = await openAgentSessionRecordStoreOnce({
        stateDirectory: root,
        hostId: 'local',
        logger: recordingStructuredAgentSessionLogger().logger
      })
      const row = journalDatabase.db
        .prepare('SELECT record_json FROM agent_session_records WHERE session_id = ?')
        .get(sessionId)
      const saved: unknown =
        typeof row?.record_json === 'string' ? JSON.parse(row.record_json) : null
      const mode = field(field(saved, 'options'), 'permissionMode')
      return typeof mode === 'string' ? mode : undefined
    },
    close: async () => {
      await stopStructuredAgentSessionRuntime()
      await store.freezeWritesAsync()
      await rm(root, { recursive: true, force: true })
    }
  }
}
