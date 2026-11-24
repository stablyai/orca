import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeWithStructuredSessionTabProjection } from './restored-chat-tab-changes'
import {
  captureStructuredSessionSurface,
  structuredSessionSurfaceIsCurrent
} from '../../agent-session/lifecycle/structured-agent-session-close'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

function createProjectionRuntime(
  hostIdsByWorkspace: ReadonlyMap<string, ExecutionHostId | null>,
  snapshots: ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>
): OrcaRuntimeWithStructuredSessionTabProjection {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: tests currentLocalStructuredSessionPresentation with only the fields it reads.
  const runtime = Object.create(
    OrcaRuntimeWithStructuredSessionTabProjection.prototype
  ) as OrcaRuntimeWithStructuredSessionTabProjection
  Object.defineProperty(runtime, 'workspaceSessions', {
    value: {
      tryGetHostId: (worktreeId: string) => hostIdsByWorkspace.get(worktreeId) ?? null
    }
  })
  Object.defineProperty(runtime, 'mobileSessionTabsByWorktree', {
    value: new Map(snapshots)
  })
  Object.defineProperty(runtime, 'localStructuredTabs', {
    value: new WeakMap()
  })
  return runtime
}

function makeHost(
  record: { location: { executionHostId: ExecutionHostId; workspaceId: string } } | undefined
): { host: StructuredAgentSessionHost; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: tests read only getSessionTabId, deps.store.getConversation, and deps.logger.warn.
  const host = {
    getSessionTabId: vi.fn(() => null),
    deps: {
      store: {
        getConversation: vi.fn(() => record)
      },
      logger: { warn }
    }
  } as unknown as StructuredAgentSessionHost
  return { host, warn }
}

function makeSnapshot(
  worktreeId: string,
  sessionId: string,
  tabId: string
): RuntimeMobileSessionTabsSnapshot {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: snapshot projection only inspects tab.type, tab.sessionId, and tab.id.
  return {
    worktreeId,
    tabs: [
      {
        id: tabId,
        type: 'agent-session',
        sessionId,
        agent: 'claude',
        title: 'Chat',
        isPinned: false,
        groupId: 'group-1'
      }
    ],
    activeTabId: tabId,
    snapshotVersion: 1,
    publicationEpoch: 1
  } as unknown as RuntimeMobileSessionTabsSnapshot
}

afterEach(() => {
  setStructuredAgentSessionHost(null)
})

describe('currentLocalStructuredSessionPresentation', () => {
  it('returns null instead of throwing when the conversation record is absent', () => {
    const { host, warn } = makeHost(undefined)
    setStructuredAgentSessionHost(host)
    const runtime = createProjectionRuntime(new Map(), new Map())

    expect(runtime.currentLocalStructuredSessionPresentation('uncommitted-session')).toBeNull()

    const surfaceRuntime = {
      currentLocalStructuredSessionPresentation: (id: string) =>
        runtime.currentLocalStructuredSessionPresentation(id),
      captureStructuredAgentSessionPresentation: (id: string) => ({
        raw: runtime.currentLocalStructuredSessionPresentation(id),
        saved: []
      }),
      retireStructuredAgentSessionTabFromSnapshot: () => false,
      removeCapturedStructuredSessionSavedTabs: () => undefined
    }
    const surface = captureStructuredSessionSurface(host, 'uncommitted-session', surfaceRuntime)
    expect(warn).not.toHaveBeenCalled()
    expect(surface).toEqual({
      tableId: null,
      presentation: { raw: null, saved: [] }
    })
    expect(
      structuredSessionSurfaceIsCurrent(host, 'uncommitted-session', surface, surfaceRuntime)
    ).toBe(true)
  })

  it('returns null when the record executionHostId is remote or the folder workspace is not local-scoped', () => {
    const remoteHostId = toRuntimeExecutionHostId('mac-host')
    const folderId = 'folder:ext-vol'
    const snapshot = makeSnapshot(folderId, 'session-1', 'tab-chat-1')

    const { host: remoteHost } = makeHost({
      location: { executionHostId: remoteHostId, workspaceId: folderId }
    })
    setStructuredAgentSessionHost(remoteHost)
    const localWorkspaceRuntime = createProjectionRuntime(
      new Map([[folderId, LOCAL_EXECUTION_HOST_ID]]),
      new Map([[folderId, snapshot]])
    )
    expect(localWorkspaceRuntime.currentLocalStructuredSessionPresentation('session-1')).toBeNull()

    const { host: localHost } = makeHost({
      location: { executionHostId: LOCAL_EXECUTION_HOST_ID, workspaceId: folderId }
    })
    setStructuredAgentSessionHost(localHost)
    const missingFolderRuntime = createProjectionRuntime(
      new Map([[folderId, null]]),
      new Map([[folderId, snapshot]])
    )
    expect(missingFolderRuntime.currentLocalStructuredSessionPresentation('session-1')).toBeNull()
  })

  it('returns the local folder workspace presentation when record and workspace are local-scoped', () => {
    const folderId = 'folder:ext-vol'
    const snapshot = makeSnapshot(folderId, 'session-1', 'tab-chat-1')
    const { host } = makeHost({
      location: { executionHostId: LOCAL_EXECUTION_HOST_ID, workspaceId: folderId }
    })
    setStructuredAgentSessionHost(host)
    const runtime = createProjectionRuntime(
      new Map([[folderId, LOCAL_EXECUTION_HOST_ID]]),
      new Map([[folderId, snapshot]])
    )

    expect(runtime.currentLocalStructuredSessionPresentation('session-1')).toEqual({
      worktreeId: folderId,
      tabId: 'tab-chat-1'
    })
  })
})
