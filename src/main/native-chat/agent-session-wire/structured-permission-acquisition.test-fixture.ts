import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultPersistedState } from '../../../shared/constants'
import {
  agentChatLaunchPermissionMode,
  type AgentChatPermissionMode
} from '../../../shared/agent-chat-permission-mode'
import type { PermissionAcquisitionHost } from '../../../shared/agent-session-permission-acquisition.test-fixture'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { updateSettings } from '../../persistence/applying-settings/settings-update'
import { RuntimeClientSettingsController } from '../../runtime/runtime-client-settings'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import {
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore,
  seedTestAgentSessionRecordStore
} from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import {
  claudeSessionIdForOrcaSession,
  createClaudeStructuredLaunchResolver
} from '../../claude/claude-structured-launch-resolution'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import { fakeClaude } from '../../claude/claude-structured-session-test-support'
import { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'
import { fakeCodex } from '../../codex/codex-structured-session-adapter-fixture'
import { codexStructuredPermissionPolicy } from '../../codex/codex-structured-permission-policy'
import { withAgentChatPermissionSeed } from '../agent-chat-permission-mode-setting'
import {
  claudeAndCodexAgents,
  claudeAndCodexRouter
} from './structured-agent-session-adapter-router-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import { readStructuredAgentSessionPermissionFact } from './structured-agent-session-permission-fact'
import { record } from './structured-agent-session-restart-resume-test-harness'
import { hostTestAttachParams, hostTestMessage } from './structured-agent-session-host-test-data'

export async function permissionAcquisitionHost(
  agent: 'claude' | 'codex',
  initial: AgentChatPermissionMode,
  newChat = false
): Promise<PermissionAcquisitionHost> {
  const root = await mkdtemp(join(tmpdir(), 'orca-permission-acquisition-'))
  const state = getDefaultPersistedState(root)
  state.settings.nativeChatPermissionMode = initial
  const saved = {
    ...record({ chain: [] }),
    provider: agent,
    accountHome: {
      variable: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
      path: join(root, 'account')
    },
    location: { ...record().location, workspaceKind: 'folder' as const },
    options: { permissionMode: initial },
    lease: { ...record().lease, runtimeFence: 7 }
  }
  if (!newChat) {
    await seedTestAgentSessionRecordStore(root, { records: [saved] })
  }
  const store = await openTestAgentSessionRecordStore(root)
  const claude = fakeClaude({
    initProof: 'none',
    initSessionId: claudeSessionIdForOrcaSession(saved.sessionId),
    replayUuid: null
  })
  // Withheld until a test answers it: the host hands a starting child nothing.
  let answerInitialize = (): void => {}
  const initialized = new Promise<unknown>((resolve) => {
    answerInitialize = () => resolve({ models: [] })
  })
  const claudeAdapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: createClaudeStructuredLaunchResolver({
      store,
      resolveWorkspacePath: async () => root,
      resolveCommand: () => 'FORBIDDEN_REAL_PROVIDER',
      resolveLaunchArgs: () => [],
      resolveAuthPolicy: () => ({ stripAuthEnv: false })
    }),
    // The host learns the start proved itself only from this event, and holds sends until then.
    onEvent: (event) => {
      const mapped = structuredClaudeLifecycleEvent(event)
      if (mapped) {
        void host.handleAdapterEvent(mapped)
      }
    },
    openConnection: async (...args) => {
      const connection = await claude.openConnection(...args)
      connection.initializationResult = () => initialized
      return connection
    },
    readProcessStartTime: async () => 1
  })
  const codex = fakeCodex({ 'turn/start': () => ({ turn: { id: 'test-turn' } }) })
  const codexAdapter = new CodexStructuredSessionAdapter({
    resolveLaunch: async () => {
      const mode = agentChatLaunchPermissionMode(
        agent,
        store.getRecord(saved.sessionId)?.options,
        undefined
      )
      return {
        command: 'FORBIDDEN_REAL_PROVIDER',
        args: [],
        cwd: root,
        codexHome: saved.accountHome.path,
        resumeThreadId: null,
        permissionMode: mode,
        permissionPolicy: codexStructuredPermissionPolicy(mode)
      }
    },
    openConnection: codex.openConnection,
    readProcessStartTime: async () => 1
  })
  const adapters = { claude: claudeAdapter, codex: codexAdapter }
  const adapter = claudeAndCodexRouter(adapters, async () => {
    await Promise.all([claudeAdapter.closeAll(), codexAdapter.closeAll()])
  })
  const host = new StructuredAgentSessionHost({
    store,
    adapter,
    agents: claudeAndCodexAgents(adapters),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'stand-in-spawn',
    logger: recordingStructuredAgentSessionLogger().logger,
    idleSweep: { intervalMs: 3_600_000 }
  })
  await host.reconcileRestartLeases()
  let operation = 0
  const operationId = () => `${Date.now()}-${String(++operation).padStart(32, '0')}`
  const mutateSettings = (updates: Partial<typeof state.settings>) =>
    updateSettings(
      {
        state,
        bumpLocalWorktreeScanGeneration: () => {},
        removeRetainedBlob: () => {},
        scheduleSave: () => {},
        notifySettingsChanged: () => {}
      },
      updates
    )
  const clientSettings = new RuntimeClientSettingsController({
    getSettings: () => state.settings,
    updateSettings: mutateSettings
  })
  return {
    sessionId: saved.sessionId,
    settings: () => state.settings,
    clientSettings,
    updateSettings: mutateSettings,
    start: async () => {
      const fence = newChat ? null : 7
      const params = hostTestAttachParams(fence, {
        envelope: {
          sessionId: saved.sessionId,
          clientOperationId: operationId(),
          expectedRuntimeFence: fence,
          payloadFingerprint: ''
        },
        agent,
        provider: agent,
        location: saved.location,
        accountHome: saved.accountHome,
        providerHandle: undefined,
        ...(newChat
          ? { options: withAgentChatPermissionSeed(agent, state.settings, undefined) }
          : {})
      })
      const result = await host.attach({ callerKey: 'client' }, params)
      if (!result.ok) {
        throw new Error(JSON.stringify(result))
      }
    },
    snapshot: async () => {
      const frames: AgentSessionSubscribeEvent[] = []
      await host.subscribe({
        id: operationId(),
        sessionId: saved.sessionId,
        emit: (event) => frames.push(event)
      })
      const frame = frames[0]
      if (!frame || frame.type !== 'snapshot') {
        throw new Error('No snapshot')
      }
      return frame
    },
    fact: () => {
      const fact = readStructuredAgentSessionPermissionFact(host.deps, saved.sessionId)
      if (!fact || fact.mode === null) {
        throw new Error('No permission fact')
      }
      return { ...fact, mode: fact.mode }
    },
    readOptions: () => host.readOptions(saved.sessionId),
    answerInitialize: () => answerInitialize(),
    childPhase: () => host.collaboratorsForTests().sessions.get(saved.sessionId)?.child?.phase,
    storedIntent: async () =>
      (await readPersistedTestAgentSessionStore(root)).records[saved.sessionId],
    launchMode: () => {
      if (agent === 'claude') {
        return claude.connections[0].launch.options.extraArgs?.['dangerously-skip-permissions'] ===
          null
          ? 'bypass'
          : 'ask'
      }
      const call = codex.connections[0].calls.find((call) => call.method === 'thread/start')
      return call?.params?.approvalPolicy === 'never' ? 'bypass' : 'ask'
    },
    controls: () =>
      agent === 'claude'
        ? claude.connections[0].calls.filter((call) => call.subtype === 'set_permission_mode')
        : [],
    delivered: () =>
      agent === 'claude'
        ? claude.connections[0].sent.length
        : codex.connections[0].calls.filter((call) => call.method === 'turn/start').length,
    send: async () => {
      const body = hostTestMessage('send after changing the new-chat default')
      const result = await host.send(
        { callerKey: 'client' },
        {
          envelope: {
            sessionId: saved.sessionId,
            clientOperationId: operationId(),
            expectedRuntimeFence: store.getRecord(saved.sessionId)?.lease.runtimeFence ?? 0,
            payloadFingerprint: computeAgentSessionPayloadFingerprint({
              method: 'agentSession.send',
              sessionId: saved.sessionId,
              fields: { body }
            })
          },
          body
        }
      )
      if (!result.ok) {
        throw new Error(JSON.stringify(result))
      }
    },
    close: async () => {
      await adapter.closeAll()
      await host.flushAllStreamedEvents()
      closeTestJournalHostDatabase(root)
      await rm(root, { recursive: true, force: true })
    }
  }
}
