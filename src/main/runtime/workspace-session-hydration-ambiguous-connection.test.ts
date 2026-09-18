/**
 * A folder workspace whose project group mixes local and SSH repos resolves to an
 * ambiguous connection. That ambiguity is catalog state, not an error: the graph-sync
 * hydration sweep must skip that workspace instead of throwing, because the throw
 * wedges syncWindowGraph before its callbacks drain and the renderer startup chain
 * then never reaches hydrationSucceeded (all terminal surfaces stay unmounted).
 */
import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { OrcaRuntimeService } from './orca-runtime'

const LOCAL_REPO = {
  id: 'local-repo-1',
  path: '/Users/dev/work/local-project',
  displayName: 'local-project',
  badgeColor: 'blue',
  addedAt: 1,
  projectGroupId: 'group-mixed'
}
const SSH_REPO = {
  id: 'ssh-repo-1',
  path: '/root',
  displayName: 'root@192.168.2.201',
  badgeColor: 'green',
  addedAt: 2,
  connectionId: 'ssh-conn-1',
  projectGroupId: 'group-mixed',
  kind: 'folder' as const
}

// Mirrors the persisted shape that produced the wedge: a LOCAL folder workspace
// (no connectionId) inside a group whose repos mix local and SSH connections.
const FOLDER_WORKSPACE = {
  id: 'folder-ws-1',
  folderPath: '/Users/dev/work/local-project',
  projectGroupId: 'group-mixed',
  connectionId: null,
  executionHostId: null
}
const FOLDER_WT = 'folder:folder-ws-1'

function makeStore(options: MakeStoreOptions = {}) {
  return {
    getRepo: (id: string) => (id === SSH_REPO.id ? SSH_REPO : LOCAL_REPO),
    getRepos: () => [LOCAL_REPO, SSH_REPO],
    addRepo: () => {},
    updateRepo: () => undefined,
    getAllWorktreeMeta: () => ({}),
    getGitHubCache: () => ({ pr: {}, issue: {} }),
    setWorktreeMeta: () => undefined,
    getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
    addRetiredWorktreeName: () => {},
    mergeRetiredWorktreeNames: () => false,
    getProjectGroups: () => [
      {
        id: 'group-mixed',
        name: 'mixed',
        connectionId: options.groupConnectionId ?? null,
        parentPath: '/Users/dev/work'
      }
    ],
    getFolderWorkspaces: () => [
      { ...FOLDER_WORKSPACE, connectionId: options.workspaceConnectionId ?? null }
    ],
    getWorkspaceSession: () => ({
      tabsByWorktree: {
        [FOLDER_WT]: [
          // A serve-owned ptyId makes this tab a runtime-owned hydration candidate,
          // mirroring the persisted shape that a live SSH terminal produces.
          { id: 'tab-1', title: 'Terminal 1', ptyId: 'serve-pty-1', createdAt: 1, lastFocusedAt: 1 }
        ]
      }
    }),
    getWorkspaceSessionHostIds: () => [options.sessionHostId ?? 'local'],
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    })
  }
}

function makeGraph(): {
  tabs: []
  leaves: []
  mobileSessionTabs: RuntimeMobileSessionTabsSnapshot[]
} {
  return {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [
      {
        worktree: FOLDER_WT,
        publicationEpoch: 'renderer:test-epoch',
        snapshotVersion: 1,
        activeGroupId: 'group-1',
        activeTabId: 'tab-1',
        activeTabType: 'terminal',
        tabs: [
          {
            type: 'terminal',
            id: 'tab-1',
            parentTabId: 'tab-1',
            leafId: 'leaf-1',
            title: 'Terminal 1',
            isActive: true
          }
        ]
      }
    ]
  }
}

type MakeStoreOptions = {
  groupConnectionId?: string | null
  workspaceConnectionId?: string | null
  sessionHostId?: string
}

function makeRuntime(options: MakeStoreOptions = {}): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock store implements only the members the hydration sweep reads; the constructor takes the full RuntimeStore.
  return new OrcaRuntimeService(makeStore(options) as never)
}

function syncGraph(runtime: OrcaRuntimeService): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture graph mirrors the persisted mobile-session shape syncWindowGraph consumes.
  runtime.syncWindowGraph(1, makeGraph() as never)
}

function getHydrationTargets(runtime: OrcaRuntimeService): Map<string, unknown> {
  return (
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reaches the protected hydration-target map to observe what the sweep recorded.
    (
      runtime as unknown as {
        getWorkspaceSessionHydrationTargets: (b: boolean) => Map<string, unknown>
      }
    ).getWorkspaceSessionHydrationTargets(false)
  )
}

function resolveFolderConnectionId(
  runtime: OrcaRuntimeService,
  workspace: Partial<FolderWorkspace>
): string | null {
  return (
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reaches the protected connection resolver with a minimal workspace record.
    (
      runtime as unknown as {
        resolveFolderWorkspaceConnectionId: (
          this: OrcaRuntimeService,
          workspace: Partial<FolderWorkspace>
        ) => string | null
      }
    ).resolveFolderWorkspaceConnectionId.call(runtime, workspace)
  )
}

function graphSyncCallbacksOf(runtime: OrcaRuntimeService): (() => void)[] {
  return (
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reaches the internal callback queue startup waiters block on.
    (runtime as unknown as { graphSyncCallbacks: (() => void)[] }).graphSyncCallbacks
  )
}

describe('workspace-session hydration with ambiguous folder connections', () => {
  it('syncWindowGraph survives a mixed-host project group and still hydrates its tabs', () => {
    const runtime = makeRuntime()
    expect(() => syncGraph(runtime)).not.toThrow()
    // No-throw alone would also pass if the workspace were silently dropped;
    // the persisted tab must actually reach the hydration target map.
    expect(getHydrationTargets(runtime).has(FOLDER_WT)).toBe(true)
  })

  it('falls back to record authority (workspace, then group) when inference is ambiguous', () => {
    const runtime = makeRuntime({ groupConnectionId: 'ssh-group-conn' })
    // Workspace record wins over the group record.
    expect(
      resolveFolderConnectionId(runtime, { ...FOLDER_WORKSPACE, connectionId: 'ssh-conn-1' })
    ).toBe('ssh-conn-1')
    // Group record is the tiebreaker when the workspace record is silent —
    // keeps tabs persisted on the SSH host partition hydratable.
    expect(
      resolveFolderConnectionId(runtime, { ...FOLDER_WORKSPACE, projectGroupId: 'group-mixed' })
    ).toBe('ssh-group-conn')

    // Neither record set → local session domain.
    const localRuntime = makeRuntime()
    expect(resolveFolderConnectionId(localRuntime, FOLDER_WORKSPACE)).toBe(null)
  })

  it('hydrates ambiguous-workspace tabs persisted on the SSH host partition', () => {
    // The group's own record says SSH, so pre-ambiguity PTYs live on the SSH host.
    const runtime = makeRuntime({
      groupConnectionId: 'ssh-conn-1',
      workspaceConnectionId: 'ssh-conn-1',
      sessionHostId: 'ssh:ssh-conn-1'
    })
    expect(() => syncGraph(runtime)).not.toThrow()
    expect(getHydrationTargets(runtime).has(FOLDER_WT)).toBe(true)
  })

  it('still drains graph sync callbacks so startup waiters cannot wedge', () => {
    const runtime = makeRuntime()
    let callbackDrained = false
    graphSyncCallbacksOf(runtime).push(() => {
      callbackDrained = true
    })
    syncGraph(runtime)
    expect(callbackDrained).toBe(true)
  })
})
