import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import type {
  PermissionNarrowingHost,
  PermissionNarrowingScenario
} from '../../../shared/agent-session-permission-narrowing.test-fixture'
import { storedAgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { CodexAppServerRequestError } from '../../codex/codex-app-server-connection'
import { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'
import { fakeCodex, THREAD_ID } from '../../codex/codex-structured-session-adapter-fixture'
import { codexStructuredPermissionPolicy } from '../../codex/codex-structured-permission-policy'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  fakeClaude,
  PROVIDER_SESSION_ID
} from '../../claude/claude-structured-session-test-support'
import { claudeStructuredPermissionOptions } from '../../claude/claude-structured-permission-mode'
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
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  claudeAndCodexAgents,
  claudeAndCodexRouter
} from './structured-agent-session-adapter-router-test-support'
import {
  HOST_TEST_NOW,
  hostTestAttachParams,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import { readStructuredAgentSessionPermissionFact } from './structured-agent-session-permission-fact'
import { record } from './structured-agent-session-restart-resume-test-harness'

export async function permissionNarrowingHost(
  scenario: PermissionNarrowingScenario
): Promise<PermissionNarrowingHost> {
  const root = await mkdtemp(join(tmpdir(), 'orca-permission-narrowing-'))
  const agent = scenario === 'codex-start' ? 'codex' : 'claude'
  const model = scenario === 'claude-model' ? 'opus-auto' : 'sonnet'
  const accountHome = {
    variable: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
    path: join(root, 'account')
  }
  const saved = {
    ...record({ chain: [] }),
    provider: agent,
    accountHome,
    location: { ...record().location, workspaceKind: 'folder' as const },
    options: { permissionMode: 'auto', model },
    permissionRevision: 9,
    lease: { ...record().lease, runtimeFence: 7 }
  }
  await seedTestAgentSessionRecordStore(root, { records: [saved] })
  const store = await openTestAgentSessionRecordStore(root)
  const log = recordingStructuredAgentSessionLogger()
  const lifecycle: Promise<void>[] = []
  const codex = fakeCodex({
    'thread/start': (params) => {
      if (params && 'approvalsReviewer' in params) {
        throw new CodexAppServerRequestError(
          'thread/start',
          -32602,
          'unknown parameter approvalsReviewer'
        )
      }
      // The old server still reports its human reviewer after rejecting that parameter.
      return { thread: { id: THREAD_ID }, model, approvalsReviewer: 'user' }
    }
  })
  const codexAdapter = new CodexStructuredSessionAdapter({
    resolveLaunch: async () => {
      const mode =
        storedAgentChatPermissionMode(agent, store.getRecord(saved.sessionId)?.options) ?? 'ask'
      return {
        command: 'unused-codex',
        args: [],
        cwd: root,
        codexHome: accountHome.path,
        resumeThreadId: null,
        permissionMode: mode,
        permissionPolicy: codexStructuredPermissionPolicy(mode)
      }
    },
    openConnection: codex.openConnection,
    readProcessStartTime: async () => 1,
    mintAcquisitionGeneration: () => 'codex-generation',
    logger: log.logger
  })
  const models = [
    { value: 'opus-auto', displayName: 'Opus', supportsAutoMode: true },
    { value: 'sonnet', displayName: 'Sonnet', supportsAutoMode: false }
  ]
  const claude = fakeClaude({ initModels: models, routes: { list_models: () => models } })
  const claudeAdapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => {
      const mode =
        storedAgentChatPermissionMode(agent, store.getRecord(saved.sessionId)?.options) ?? 'ask'
      return {
        pathToClaudeCodeExecutable: 'unused-claude',
        options: claudeStructuredPermissionOptions(mode),
        cwd: root,
        claudeConfigDir: accountHome.path,
        providerSessionId: PROVIDER_SESSION_ID,
        resumeLeafUuid: null,
        resumesTranscript: false,
        continuesChain: false,
        permissionMode: mode
      }
    },
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1,
    logger: log.logger,
    onEvent: (event) => {
      const mapped = structuredClaudeLifecycleEvent(event)
      if (mapped) {
        lifecycle.push(host.handleAdapterEvent(mapped))
      }
    }
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
    mintSpawnToken: () => 'spawn-test',
    logger: log.logger,
    idleSweep: { intervalMs: 3_600_000 },
    now: () => HOST_TEST_NOW
  })
  await host.reconcileRestartLeases()
  const frames: AgentSessionSubscribeEvent[] = []
  await host.subscribe({
    id: 'reader',
    sessionId: saved.sessionId,
    emit: (event) => frames.push(event)
  })
  const fact = () => {
    const value = readStructuredAgentSessionPermissionFact(host.deps, saved.sessionId)
    if (!value || value.mode === null || value.revision === undefined) {
      throw new Error('No ordered fact')
    }
    return { mode: value.mode, fence: value.fence, revision: value.revision }
  }
  return {
    sessionId: saved.sessionId,
    agent,
    frames,
    fact,
    start: async () => {
      const params = hostTestAttachParams(7, {
        envelope: {
          sessionId: saved.sessionId,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: 7,
          payloadFingerprint: ''
        },
        agent,
        provider: agent,
        location: saved.location,
        accountHome,
        providerHandle: undefined
      })
      const result = await host.attach({ callerKey: 'client' }, params)
      if (!result.ok) {
        throw new Error(JSON.stringify({ result, logs: log.entries }))
      }
      if (agent === 'claude') {
        await claudeAdapter.awaitOptionWritable(saved.sessionId)
        await Promise.all(lifecycle)
      } else {
        const calls = codex.connections[0].calls.filter((call) => call.method === 'thread/start')
        expect(calls).toHaveLength(2)
        expect(calls[0]?.params).toHaveProperty('approvalsReviewer', 'auto_review')
        expect(calls[1]?.params).not.toHaveProperty('approvalsReviewer')
      }
    },
    switchModel: async () => {
      const fields = { key: 'model', value: 'sonnet' }
      const result = await host.setOption(
        { callerKey: 'client' },
        {
          ...fields,
          envelope: {
            sessionId: saved.sessionId,
            expectedRuntimeFence: fact().fence,
            clientOperationId: hostTestOperationId(),
            payloadFingerprint: computeAgentSessionPayloadFingerprint({
              method: 'agentSession.setOption',
              sessionId: saved.sessionId,
              fields
            })
          }
        }
      )
      expect(result).toMatchObject({
        ok: true,
        value: { options: { permissionMode: 'ask' }, permissionFact: { mode: 'ask', revision: 10 } }
      })
    },
    readOptions: () => host.readOptions(saved.sessionId),
    storedIntent: async () => {
      const value = (await readPersistedTestAgentSessionStore(root)).records[saved.sessionId]
      return { options: value?.options, permissionRevision: value?.permissionRevision }
    },
    close: async () => {
      await adapter.closeAll()
      await Promise.all(lifecycle)
      await host.flushAllStreamedEvents()
      closeTestJournalHostDatabase(root)
      await rm(root, { recursive: true, force: true })
    }
  }
}
