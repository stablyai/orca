import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { normalizeExecutionHostId } from '../../shared/execution-host'
import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { seedTestAgentSessionRecordStore } from './agent-session-record-store-test-harness'
import { OrcaRuntimeService } from './orca-runtime'
import { withChatTabChanges } from './agent-session/agent-session-tab-layout'
import {
  chatTabCommandsSettled as settled,
  layoutApplyOn
} from './session-layout-apply.test-fixture'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { partialRuntimeStore } from './runtime-store-partial-fixture'

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
    // An unsaved partition reads as the default layout, as the Store answers it.
    getWorkspaceSession: (hostId = 'local') =>
      hostId === 'local' ? state.session : (partitions.get(hostId) ?? getDefaultWorkspaceSession()),
    getWorkspaceSessionHostIds: () =>
      ['local', ...partitions.keys()].flatMap((id) => normalizeExecutionHostId(id) ?? []),
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
  const runtime = new OrcaRuntimeService(partialRuntimeStore(store))
  for (const sessionId of sessionIds) {
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: WT,
      sessionId,
      agent: 'codex',
      activate: false
    })
  }
  await settled()
  return { runtime, state }
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
