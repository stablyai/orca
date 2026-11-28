import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import type { RuntimeWorktreePsSummary } from '../../../shared/worktree/catalog/runtime-worktree-contracts'
import { buildFolderMembership } from './workspace-cleanup-folder-membership'
import { readPairedFolderChildren } from './workspace-cleanup-paired-folder-children'
import { decideWorkspaceCleanups } from './workspace-cleanup-removal-step'
import type { WorkspaceCleanupWorkspace } from './workspace-cleanup-run-evidence'

vi.mock('../../runtime/hosts/platform-probe/host-descriptor', () => ({
  readCallerStoreInstallationId: vi.fn(async () => 'install-local')
}))

function createStubStore(): RuntimeStore {
  const raw = {
    getBots: () => [],
    getAllWorkspaceLineage: () => ({}),
    getAllWorktreeLineage: () => ({}),
    getAllCrossStoreWorkspaceLineage: () => ({}),
    getWorktreeMeta: () => undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Minimal test double implementing only the RuntimeStore methods read by buildFolderMembership.
  return raw as unknown as RuntimeStore
}

function createStubRuntime(): OrcaRuntimeService {
  const raw = {
    getLocalProvider: () => ({ listProcesses: async () => [] }),
    listTerminals: async () => ({ terminals: [], truncated: false })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Minimal test double implementing only the terminal methods read by decideWorkspaceCleanups.
  return raw as unknown as OrcaRuntimeService
}

function summary(worktreeId: string, folderId: string): RuntimeWorktreePsSummary {
  const raw = {
    worktreeId,
    repoId: 'repo-1',
    path: `/tmp/${worktreeId}`,
    displayName: worktreeId,
    branch: 'feat',
    isMainWorktree: false,
    isPinned: false,
    isActive: false,
    isArchived: false,
    createdAt: 0,
    lastActivityAt: 0,
    unverifiableTerminalCount: 0,
    agents: [],
    workspaceLineage: {
      childWorkspaceKey: `worktree:${worktreeId}`,
      parentWorkspaceKey: `folder:${folderId}`,
      capturedAt: 1
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test fixture with all RuntimeWorktreePsSummary fields inspected by buildFolderMembership.
  return raw as unknown as RuntimeWorktreePsSummary
}

function makeWorkspace(
  row: RuntimeWorktreePsSummary,
  membership: ReturnType<typeof buildFolderMembership>,
  overrides: Partial<WorkspaceCleanupWorkspace> & { clean?: boolean; pinned?: boolean } = {}
): WorkspaceCleanupWorkspace {
  const { clean = true, pinned = false, ...rest } = overrides
  const rawRepo = { id: 'repo-1', path: '/tmp/repo-1', displayName: 'repo' }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Minimal repo fixture with the fields read by getEffectiveHooks and ref construction.
  const repo = rawRepo as WorkspaceCleanupWorkspace['repo']
  return {
    ref: {
      worktreeId: row.worktreeId,
      repoId: 'repo-1',
      repoName: 'repo',
      displayName: row.displayName,
      branch: 'feat',
      path: row.path
    },
    repo,
    policy: {
      source: 'global',
      inactiveActionSupported: false,
      rules: {
        merged: { enabled: true },
        unchanged: { enabled: false, afterDays: 7 },
        inactive: { enabled: false, afterDays: 30, action: 'delete' },
        automationRuns: { enabled: false },
        orchestrationWorkers: { enabled: false },
        keepWhen: 'uncommitted'
      }
    },
    input: {
      reasons: ['merged'],
      blockers: pinned ? ['pinned'] : [],
      lastActivityAt: 0,
      git: { clean, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 1 }
    },
    paneAgentStates: new Map(),
    removing: false,
    identity: `local|${row.worktreeId}`,
    folderSiblings: membership.siblingsOf(row),
    localFolderKey: membership.localFolderKeyOf(row),
    findPairedHeldFolders: membership.findPairedHeldFolders,
    readPairedFolderChildren: async () => ({ complete: true, children: [] }),
    ...rest
  }
}

describe('workspace cleanup folder-group and paired-host invariants', () => {
  it('readPairedFolderChildren uses readyOnly and bounds concurrency without waking idle servers', async () => {
    let active = 0
    let maxActive = 0
    const readyOnlyFlags: unknown[] = []
    const pending: (() => void)[] = []
    const servers = Array.from({ length: 10 }, (_, i) => ({
      environmentId: `env-${i}`,
      name: `server-${i}`
    }))
    const runtime = {
      getRuntimeId: () => 'rt-local',
      listOrchestrationWorkerServers: async () => servers,
      callOrchestrationWorkerServer: async (
        environmentId: string,
        _method: string,
        _params: unknown,
        _timeoutMs?: number,
        _envelope?: unknown,
        internal?: { readyOnly?: boolean }
      ) => {
        readyOnlyFlags.push(internal?.readyOnly)
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise<void>((resolve) => {
          pending.push(resolve)
        })
        active -= 1
        if (environmentId === 'env-3') {
          throw new Error('Paired server is not currently connected.')
        }
        return { crossStoreLineage: {} }
      }
    }

    const resultPromise = readPairedFolderChildren(runtime)
    let settled = false
    void resultPromise.finally(() => {
      settled = true
    })
    while (!settled) {
      if (pending.length > 0) {
        const wave = pending.splice(0)
        wave.forEach((resolve) => resolve())
      }
      await Promise.resolve()
    }
    const result = await resultPromise
    expect(readyOnlyFlags).toEqual(Array(10).fill(true))
    expect(maxActive).toBe(4)
    expect(result).toEqual({ complete: false, children: [] })
  })

  it('shares the folder sibling list across members and skips paired reads when no folder member is removable', async () => {
    const store = createStubStore()
    const a = summary('wt-a', 'f-1')
    const b = summary('wt-b', 'f-1')
    const membership = buildFolderMembership(store, [a, b])
    expect(membership.siblingsOf(a)).toBe(membership.siblingsOf(b))

    const readPaired = vi.fn(async () => ({ complete: true, children: [] }))
    const verdicts = await decideWorkspaceCleanups(
      createStubRuntime(),
      [
        makeWorkspace(a, membership, { pinned: true, readPairedFolderChildren: readPaired }),
        makeWorkspace(b, membership, { clean: true, readPairedFolderChildren: readPaired })
      ],
      10_000_000
    )
    expect(verdicts[0]).toEqual({ action: 'keep', cause: 'pinned' })
    expect(verdicts[1]).toEqual({
      action: 'keep',
      cause: 'folder-workspace-sibling',
      reason: 'merged'
    })
    expect(readPaired).not.toHaveBeenCalled()
  })

  it('holds a removable local folder when a paired child is attached', async () => {
    const store = createStubStore()
    const a = summary('wt-a', 'f-1')
    const membership = buildFolderMembership(store, [a])
    const readPaired = vi.fn(async () => ({
      complete: true,
      children: [
        {
          identity: 'runtime:env-1|wt-remote',
          parentWorkspaceKey: 'folder:f-1',
          parentInstanceId: 'inst-1'
        }
      ]
    }))

    const verdicts = await decideWorkspaceCleanups(
      createStubRuntime(),
      [makeWorkspace(a, membership, { readPairedFolderChildren: readPaired })],
      10_000_000
    )
    expect(readPaired).toHaveBeenCalledTimes(1)
    expect(verdicts[0]).toEqual({
      action: 'keep',
      cause: 'folder-workspace-sibling',
      reason: 'merged'
    })
  })
})
