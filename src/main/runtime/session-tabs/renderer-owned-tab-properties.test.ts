import '../orca-runtime-tests/orca-runtime-test-lifecycle.spec'
import { expect, it, vi } from 'vitest'

import { mkdtemp, rm } from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'

import { closeTestJournalHostDatabases } from '../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'

import { createStructuredChatNamingHandler } from '../../native-chat/structured-chat-naming'

import { recordingStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger.test-fixture'

import {
  ensureTestStructuredAgentSessionHost as ensureStructuredAgentSessionHost,
  readPersistedTestAgentSessionStore,
  seedTestAgentSessionRecordStore
} from '../agent-session/records/agent-session-record-store-test-harness'

import { stopStructuredAgentSessionRuntime } from '../agent-session/structured-agent-session-runtime'

import type { AgentSessionRecordStore } from '../agent-session/records/agent-session-record-store'

import '../orca-runtime-tests/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'

import { electronMocks } from '../orca-runtime-test-mocks/setup.spec'

import {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-tests/orca-runtime-test-fixtures.spec'

import type { RuntimeNotifier } from '../client/events/runtime-notifier-contract'

import { RpcDispatcher } from '../rpc/dispatcher'

import { SESSION_TAB_MUTATION_METHODS } from '../rpc/methods/session-tabs/session-tab-mutation-methods'

function fixture(session = makeWorkspaceSessionWithHeadlessTerminal()) {
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
  const runtime = new OrcaRuntimeService(runtimeStore)
  const notifier = {
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  } satisfies RuntimeNotifier
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false })
  runtime.setNotifier(notifier)
  const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_MUTATION_METHODS })
  return { runtime, runtimeStore, getSession, session, notifier, dispatcher }
}

it('refuses a combined native chat edit before saving its name, while accepting a title alone', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-native-tab-props-'))
  const record = {
    ...agentSessionRecordFixture(
      agentSessionLeaseFixture({
        ownerProcess: null,
        reservedSpawnToken: null,
        claimStatus: 'released'
      })
    ),
    conversationName: 'Existing saved name'
  }
  const sessionId = record.sessionId
  const tabId = `agent-session:${sessionId}`
  const alias = 'Existing tab alias'
  const { runtime, dispatcher, getSession, notifier } = fixture(
    makeWorkspaceSessionWithHeadlessTerminal({
      unifiedTabs: {
        [TEST_WORKTREE_ID]: [
          {
            id: `structured-agent-session-${sessionId}`,
            entityId: sessionId,
            groupId: 'group',
            worktreeId: TEST_WORKTREE_ID,
            contentType: 'agent-session',
            agentSessionAgent: 'claude',
            label: 'Claude Chat',
            customLabel: alias,
            color: null,
            sortOrder: 1,
            createdAt: 1
          }
        ]
      }
    })
  )
  try {
    await seedTestAgentSessionRecordStore(directory, {
      records: [record]
    })
    let recordStore: AgentSessionRecordStore | null = null
    const { logger } = recordingStructuredAgentSessionLogger()
    const host = await ensureStructuredAgentSessionHost({
      logger,
      stateDirectory: directory,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => directory,
      resolveEnvironment: async () => ({}),
      resolveLaunchArgs: () => [],
      resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
      conversationNaming: createStructuredChatNamingHandler({
        getStore: () => recordStore,
        getSettings: () => ({}),
        workerTaskTitle: () => null,
        readFirstPrompt: async () => '',
        readJournalFirstPrompt: async () => '',
        generate: async () => null,
        onNamed: () => {},
        logger
      })
    })
    recordStore = host.deps.store
    vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
    runtime['storeMobileSessionSnapshot'](TEST_WORKTREE_ID, {
      worktree: TEST_WORKTREE_ID,
      publicationEpoch: 'native-tab-props',
      snapshotVersion: 1,
      activeGroupId: 'group',
      activeTabId: tabId,
      activeTabType: 'agent-session',
      tabs: [
        {
          type: 'agent-session',
          id: tabId,
          sessionId,
          agent: 'claude',
          title: 'Existing saved name',
          isActive: true
        }
      ]
    })
    const before = await readPersistedTestAgentSessionStore(directory)
    expect(before.records[sessionId]?.conversationName).toBe('Existing saved name')
    const params = {
      worktree: `id:${TEST_WORKTREE_ID}`,
      tabId,
      customTitle: ' Renamed through tab props '
    }
    expect(
      await dispatcher.dispatch({
        id: 'native-combined',
        authToken: 'token',
        method: 'session.tabs.setTabProps',
        params: { ...params, isPinned: true }
      })
    ).toMatchObject({ ok: false, error: { code: 'capability_unsupported' } })
    expect({
      saved: await readPersistedTestAgentSessionStore(directory),
      alias: getSession().unifiedTabs?.[TEST_WORKTREE_ID]?.[0]?.customLabel
    }).toEqual({ saved: before, alias })
    expect(notifier.renameTerminal).not.toHaveBeenCalled()

    expect(
      await dispatcher.dispatch({
        id: 'native-title',
        authToken: 'token',
        method: 'session.tabs.setTabProps',
        params
      })
    ).toMatchObject({ ok: true, result: { updated: true } })
    expect(
      (await readPersistedTestAgentSessionStore(directory)).records[sessionId]?.conversationName
    ).toBe('Renamed through tab props')
    expect(getSession().unifiedTabs?.[TEST_WORKTREE_ID]?.[0]?.customLabel).toBe(alias)
    expect(notifier.renameTerminal).not.toHaveBeenCalled()
  } finally {
    await stopStructuredAgentSessionRuntime()
    await closeTestJournalHostDatabases()
    await rm(directory, { recursive: true, force: true })
  }
})
