import { isAgentSessionProviderHandleChain } from '../../shared/agent-session-provider-handle'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { publishCommittedPtySpawn } from '../ipc/pty/spawn-commit-publication'
import type { PtySpawnCommitInput } from '../ipc/pty/spawn-commit-assembly'
import { createRuntimePtySpawnState } from '../ipc/pty/runtime/spawn-state'
import { createPtySpawnCommitDependencies } from '../persistence/loading-store/pty-spawn-commit-dependencies-fixture'
import { unregisterPty } from '../memory/pty-registry'
import { AgentSessionStoreTransactions } from './agent-session-store-transactions'
import * as storeDraft from './agent-session-store-draft'
import * as storeRows from './agent-session-record-rows'
// A windowless host's saved chat tab against a real chat host: the index hiding a chat reaches the
// runtime and takes the tab out of the layout, and a chat whose record is gone loses its tab.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import {
  readPersistedTestAgentSessionStore,
  seedTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import { OrcaRuntimeService } from './orca-runtime'
import { withChatTabChanges } from './agent-session-tab-layout'
import {
  chatTabCommandsSettled as settled,
  layoutApplyOn
} from './session-layout-apply.test-fixture'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

const WT = 'workspace-1'
// Session ids are 8 to 128 characters; a shorter one is not a readable record.
const CHAT_A = 'chat-a-0001'
const CHAT_B = 'chat-b-0002'
const CHAT_GONE = 'chat-gone-0003'
const CHAT_SSH = 'chat-ssh-0004'
const CHAT_REMOTE = 'chat-remote-0005'
const CHAT_CLAUDE = 'chat-claude-0006'
const EMPTY_SESSION: WorkspaceSessionState = {
  activeRepoId: null,
  activeWorktreeId: WT,
  activeTabId: null,
  tabsByWorktree: {},
  terminalLayoutsByTabId: {}
}
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-windowless-chat-layout-'))
})

afterEach(async () => {
  await stopStructuredAgentSessionRuntime().catch(() => undefined)
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function released(sessionId: string) {
  return agentSessionRecordFixture(
    agentSessionLeaseFixture({
      sessionId,
      ownerProcess: null,
      reservedSpawnToken: null,
      claimStatus: 'released'
    })
  )
}

/** A runtime with no window whose layout saves a tab for each chat. */
/** `partitions` are saved layouts besides the local one, by partition id. */
async function runtimeWithSavedChats(
  sessionIds: string[],
  partitions = new Map<string, WorkspaceSessionState>()
) {
  const state: { session: WorkspaceSessionState } = {
    session: {
      activeRepoId: null,
      activeWorktreeId: WT,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    }
  }
  const store = {
    getRepos: () => [],
    getSettings: () => ({}),
    getWorkspaceSession: (hostId = 'local') =>
      hostId === 'local' ? state.session : (partitions.get(hostId) ?? null),
    getWorkspaceSessionHostIds: () => ['local', ...partitions.keys()],
    setWorkspaceSession: (next: WorkspaceSessionState, hostId = 'local') => {
      if (hostId === 'local') {
        state.session = next
      } else {
        partitions.set(hostId, next)
      }
    },
    applyLayoutCommand: layoutApplyOn(
      (hostId) => (hostId === 'local' ? state.session : (partitions.get(hostId) ?? null)),
      (next, hostId) => store.setWorkspaceSession(next, hostId)
    )
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only these store methods on these paths.
  const runtime = new OrcaRuntimeService(store as never)
  for (const sessionId of sessionIds) {
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: WT,
      sessionId,
      agent: 'codex',
      activate: false
    })
  }
  await settled()
  return { runtime, state, store }
}

function installHost(runtime: OrcaRuntimeService) {
  return ensureStructuredAgentSessionHost({
    logger: recordingStructuredAgentSessionLogger().logger,
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => root,
    resolveEnvironment: async () => ({}),
    resolveLaunchArgs: () => [],
    resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
    onSessionTabHidden: (sessionId) => runtime.onStructuredSessionTabHidden(sessionId)
  })
}

/** A runtime whose startup restore installs a host rooted at `root`, with no PTY daemon. */
function restoringRuntime(runtime: OrcaRuntimeService): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the runtime's own protected members; the test roots the host at `root` and stubs the PTY daemon.
  const internal = runtime as unknown as {
    hasPersistedStructuredAgentSessionStore(): boolean
    ensureStructuredAgentSessionHost(): Promise<unknown>
    refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
  }
  internal.hasPersistedStructuredAgentSessionStore = () => true
  internal.ensureStructuredAgentSessionHost = () => installHost(runtime)
  internal.refreshMobileSessionPtyRecords = async () => new Set<string>()
}

function shown(...sessionIds: string[]) {
  return sessionIds.map((sessionId) => ({
    tabId: structuredAgentSessionTabId(sessionId),
    sessionId
  }))
}

function savedChatIds(state: { session: WorkspaceSessionState }): string[] {
  return (state.session.unifiedTabs?.[WT] ?? [])
    .filter((tab) => tab.contentType === 'agent-session')
    .map((tab) => tab.entityId)
}

describe('a windowless chat tab against the chat host', () => {
  it('leaves the layout when the host hides the chat', async () => {
    await seedTestAgentSessionRecordStore(root, {
      records: [released(CHAT_A), released(CHAT_B)],
      sessionTabs: shown(CHAT_A, CHAT_B)
    })
    const { runtime, state } = await runtimeWithSavedChats([CHAT_A, CHAT_B])
    expect(savedChatIds(state)).toEqual([CHAT_A, CHAT_B])
    const host = await installHost(runtime)
    expect(host.deps.store.getRecord(CHAT_A)).not.toBeNull()

    await host.setSessionTabVisibility(CHAT_A, false)
    await settled()

    expect(savedChatIds(state)).toEqual([CHAT_B])
  })

  it('leaves the layout at startup when the chat record is gone, and keeps a listed one', async () => {
    await seedTestAgentSessionRecordStore(root, {
      records: [released(CHAT_B)],
      sessionTabs: shown(CHAT_B)
    })
    const { runtime, state } = await runtimeWithSavedChats([CHAT_GONE, CHAT_B])
    expect(savedChatIds(state)).toEqual([CHAT_GONE, CHAT_B])
    restoringRuntime(runtime)

    await runtime.restoreStructuredAgentSessionTabs()
    await settled()

    expect(savedChatIds(state)).toEqual([CHAT_B])
  })

  it("removes a closed Claude chat's saved tab at startup", async () => {
    await seedTestAgentSessionRecordStore(root, {
      records: [released(CHAT_B)],
      sessionTabs: shown(CHAT_B)
    })
    const { runtime, state } = await runtimeWithSavedChats([CHAT_B])
    state.session = withChatTabChanges('local', state.session, WT, [
      {
        open: {
          sessionId: CHAT_CLAUDE,
          agent: 'claude',
          tabId: structuredAgentSessionTabId(CHAT_CLAUDE)
        }
      }
    ])!
    expect(savedChatIds(state)).toEqual([CHAT_B, CHAT_CLAUDE])
    restoringRuntime(runtime)

    await runtime.restoreStructuredAgentSessionTabs()
    await settled()

    expect(savedChatIds(state)).toEqual([CHAT_B])
  })

  it('keeps the tab of a chat whose record this build cannot read', async () => {
    // An id the current record shape rejects stands in for a record a newer build wrote.
    await seedTestAgentSessionRecordStore(root, {
      records: [released(CHAT_B), released('short')],
      sessionTabs: shown(CHAT_B)
    })
    const { runtime, state } = await runtimeWithSavedChats(['short', CHAT_B])
    restoringRuntime(runtime)

    await runtime.restoreStructuredAgentSessionTabs()
    await settled()

    expect(savedChatIds(state)).toEqual(['short', CHAT_B])
  })

  it("leaves another execution host's chat tab alone at startup", async () => {
    await seedTestAgentSessionRecordStore(root, {
      records: [released(CHAT_B)],
      sessionTabs: shown(CHAT_B)
    })
    const { runtime, state } = await runtimeWithSavedChats([CHAT_B])
    state.session = withChatTabChanges('ssh:box', state.session, WT, [
      {
        open: {
          sessionId: CHAT_SSH,
          agent: 'codex',
          tabId: structuredAgentSessionTabId(CHAT_SSH)
        }
      }
    ])!
    restoringRuntime(runtime)

    await runtime.restoreStructuredAgentSessionTabs()
    await settled()

    expect(savedChatIds(state)).toEqual([CHAT_B, CHAT_SSH])
  })

  it("leaves a remote server's mirrored chat tab alone at startup", async () => {
    await seedTestAgentSessionRecordStore(root, {
      records: [released(CHAT_B)],
      sessionTabs: shown(CHAT_B)
    })
    // A desktop mirrors a remote server's chat into that server's partition with no host stamp.
    const mirrored = withChatTabChanges('local', EMPTY_SESSION, WT, [
      {
        open: {
          sessionId: CHAT_REMOTE,
          agent: 'codex',
          tabId: structuredAgentSessionTabId(CHAT_REMOTE)
        }
      }
    ])!
    const unifiedTabs = {
      [WT]: (mirrored.unifiedTabs?.[WT] ?? []).map(({ executionHostId: _host, ...tab }) => tab)
    }
    const partitions = new Map([['runtime:env-y', { ...mirrored, unifiedTabs }]])
    const { runtime } = await runtimeWithSavedChats([CHAT_B], partitions)
    restoringRuntime(runtime)

    await runtime.restoreStructuredAgentSessionTabs()
    await settled()

    expect(partitions.get('runtime:env-y')?.unifiedTabs?.[WT]?.map((tab) => tab.entityId)).toEqual([
      CHAT_REMOTE
    ])
  })

  it('prunes nothing at startup when the store has no tab index', async () => {
    await seedTestAgentSessionRecordStore(root, { records: [released(CHAT_B)] })
    const { runtime, state } = await runtimeWithSavedChats([CHAT_GONE, CHAT_B])
    restoringRuntime(runtime)

    await runtime.restoreStructuredAgentSessionTabs()
    await settled()

    expect(savedChatIds(state)).toEqual([CHAT_GONE, CHAT_B])
  })
})

it.each([
  [8, 1],
  [80, 1],
  [256, 1],
  [8, 10]
])('measures retirement at %i links/%i sessions', async (k, sessions) => {
  const record = released(CHAT_A)
  record.provider = 'codex'
  const handle = codexProviderHandle('88888888-8888-4888-8888-888888888888')
  record.providerHandleChain = Array.from({ length: k }, (_, index) => ({
    linkId: `link-${index}`,
    origin: index === 0 ? 'created' : 'resumed',
    mintedAtFence: index + 1,
    observedAt: index + 1,
    handle
  }))
  record.lease = { ...record.lease, runtimeFence: k, provenHandleLinkId: `link-${k - 1}` }
  expect(isAgentSessionProviderHandleChain(record.providerHandleChain)).toBe(true)
  const ids = Array.from({ length: sessions }, (_, i) => (i ? `chat-matching-${i}` : CHAT_A))
  const records = ids.map((sessionId) => ({
    ...record,
    sessionId,
    lease: { ...record.lease, sessionId }
  }))
  await seedTestAgentSessionRecordStore(root, {
    records: [...records, released(CHAT_B)],
    sessionTabs: shown(...ids, CHAT_B)
  })
  const { runtime, state, store } = await runtimeWithSavedChats([...ids, CHAT_B])
  for (let index = 0; index < 3; index += 1) {
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: `other-${index}`,
      sessionId: CHAT_B,
      agent: 'codex',
      activate: false
    })
  }
  const host = await installHost(runtime)
  const probes = {
    visibility: vi.spyOn(host, 'setSessionTabVisibility'),
    transactions: vi.spyOn(AgentSessionStoreTransactions.prototype, 'transact'),
    drafts: vi.spyOn(storeDraft, 'draftAgentSessionStoreState'),
    differences: vi.spyOn(storeDraft, 'agentSessionStoreDraftRowWrites'),
    changedRowCommits: vi.spyOn(storeRows, 'writeAgentSessionStoreRows'),
    hidden: vi.spyOn(runtime, 'onStructuredSessionTabHidden'),
    savedWrites: vi.spyOn(store, 'setWorkspaceSession'),
    layoutCommands: vi.spyOn(store, 'applyLayoutCommand'),
    retirement: vi.spyOn(runtime, 'retireStructuredAgentSessionTabFromSnapshot')
  }
  const publications = vi.fn()
  const unsubscribe = runtime.onMobileSessionTabsChanged(publications)
  const dismissals = vi.spyOn(host.restartResume, 'dismiss')
  const visits = { recordVisits: 0, snapshotVisits: 0, findVisits: 0 }
  for (const method of [Symbol.iterator, 'values'] as const) {
    const original = Map.prototype[method]
    vi.spyOn(Map.prototype, method).mockImplementation(function* (this: Map<unknown, unknown>) {
      for (const item of original.call(this)) {
        const value = method === 'values' ? item : item[1]
        if (typeof value === 'object' && value !== null) {
          if ('providerHandleChain' in value) {
            visits.recordVisits += 1
          }
          if ('snapshotVersion' in value && 'tabs' in value) {
            visits.snapshotVisits += 1
          }
        }
        yield item
      }
      return undefined
    })
  }
  const find = Array.prototype.find
  vi.spyOn(Array.prototype, 'find').mockImplementation(function (
    this: ArrayLike<unknown>,
    predicate,
    thisArg
  ) {
    return find.call(this, (value, index, array) => {
      visits.findVisits += 1
      return predicate.call(thisArg, value, index, array)
    })
  })
  const reply = {
    id: `perf-retirement-${k}`,
    savedResumeDecision: {
      agent: 'codex' as const,
      providerSession: { key: 'session_id' as const, id: handle.nativeId },
      verdict: 'admitted' as const
    }
  }
  const ports = createPtySpawnCommitDependencies(runtime)
  const spawnState = createRuntimePtySpawnState(ports, {
    cols: 80,
    rows: 24,
    resumeOrigin: 'switch',
    worktreeId: WT
  })
  spawnState.result = reply
  const commit: PtySpawnCommitInput<typeof reply> = {
    state: spawnState,
    nativeWindowsConptySpawn: false,
    seedPaneKey: null,
    registration: {
      store: undefined,
      worktreeId: WT,
      shellOverride: undefined,
      rendererLaunchAuthority: null
    },
    preAllocatedHandle: null,
    paneKey: null,
    memorySessionId: null,
    resumeArgvDropped: false,
    codexLaunchEnv: undefined,
    initiallyHidden: false,
    hiddenDelivery: 'runtime-owned',
    earlyExit: 'throw',
    joinPayload: { reservation: reply, reply }
  }
  const counts = () => ({
    ...Object.fromEntries(Object.entries(probes).map(([key, spy]) => [key, spy.mock.calls.length])),
    dismissals: dismissals.mock.calls.length,
    publications: publications.mock.calls.length,
    ...visits
  })
  try {
    expect(await publishCommittedPtySpawn(commit)).toBe(reply)
    const beforeDrain = counts()
    await Promise.all(dismissals.mock.results.map(({ value }) => value))
    await settled()
    const afterDrain = counts()
    console.info('RETIREMENT_WORK', JSON.stringify({ k, sessions, beforeDrain, afterDrain }))
    expect(
      afterDrain.recordVisits + afterDrain.snapshotVisits + afterDrain.findVisits
    ).toBeLessThanOrEqual(128 * k * sessions * sessions)
    expect(host.deps.store.getVisibleSessionTabIndex().sessionIds).toEqual([CHAT_B])
    expect(savedChatIds(state)).toEqual([CHAT_B])
    expect((await readPersistedTestAgentSessionStore(root)).sessionTabs).toEqual(shown(CHAT_B))
    expect(host.collaboratorsForTests().sessions.size).toBe(0)
  } finally {
    unsubscribe()
    unregisterPty(reply.id)
    vi.restoreAllMocks()
  }
})
