import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import type { RuntimeWorktreePsSummary } from '../../../shared/worktree/catalog/runtime-worktree-contracts'
import type { WorkspaceCleanupBlocker } from '../../../shared/workspace-cleanup/workspace-cleanup'
import type { WorkspaceCleanupRules } from '../../../shared/workspace-cleanup/workspace-cleanup-policy'

const dirty = vi.hoisted(() => new Set<string>())

// Git evidence is the scan's job; here every listed checkout is merged and clean unless marked dirty.
vi.mock('../../ipc/workspace-cleanup/workspace-cleanup-scan', () => ({
  scanWorkspaceCleanup: async (_store: unknown, args: { worktreeIds: string[] }) => ({
    candidates: args.worktreeIds.map((worktreeId) => ({
      worktreeId,
      executionHostId: 'local',
      reasons: ['merged'],
      blockers: (dirty.has(worktreeId) ? ['dirty-files'] : []) satisfies WorkspaceCleanupBlocker[],
      lastActivityAt: 0,
      git: { clean: !dirty.has(worktreeId), upstreamAhead: 0, upstreamBehind: 0, checkedAt: 1 }
    }))
  })
}))

// This store's own identity, which a paired server's child names as its parent's store.
vi.mock('../../runtime/hosts/platform-probe/host-descriptor', () => ({
  readCallerStoreInstallationId: async () => 'this-store'
}))
vi.mock('../../persistence/loading-store/user-data-path', () => ({
  getCanonicalUserDataPath: () => '/nonexistent'
}))

import { WorkspaceCleanupRunner } from './workspace-cleanup-runner'
import { collectWorkspaceCleanupWorkspaces } from './workspace-cleanup-run-evidence'
import { removeWorkspaceForCleanup } from './workspace-cleanup-removal-step'

const RULES: WorkspaceCleanupRules = {
  merged: { enabled: true },
  unchanged: { enabled: false, afterDays: 1 },
  inactive: { enabled: false, afterDays: 30, action: 'delete' },
  automationRuns: { enabled: false },
  orchestrationWorkers: { enabled: false },
  keepWhen: 'any-local-files'
}

function row(
  worktreeId: string,
  lineage: {
    folder?: string
    parent?: string
    hostId?: string
    instance?: string
    /** A parent in another Orca store: its store, its workspace key and instance, and how the link was made. */
    elsewhere?: { store: string; key: string; instance?: string; origin?: string; capture?: string }
  } = {}
): RuntimeWorktreePsSummary {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: cleanup reads only these listing fields.
  return {
    workspaceKind: 'git',
    worktreeId,
    repoId: worktreeId.split('::')[0],
    ...(lineage.hostId ? { hostId: lineage.hostId } : {}),
    ...(lineage.instance ? { worktreeInstanceId: lineage.instance } : {}),
    path: worktreeId.split('::')[1],
    branch: 'refs/heads/feature',
    displayName: worktreeId,
    isArchived: false,
    isMainWorktree: false,
    isPinned: false,
    isActive: false,
    unverifiableTerminalCount: 0,
    agents: [],
    parentWorktreeId: lineage.parent ?? null,
    workspaceLineage: lineage.folder ? { parentWorkspaceKey: `folder:${lineage.folder}` } : null,
    ...(lineage.elsewhere
      ? {
          crossStoreParent: {
            parent: {
              installationId: lineage.elsewhere.store,
              workspaceKey: lineage.elsewhere.key,
              instanceId: lineage.elsewhere.instance ?? 'parent-instance'
            },
            origin: lineage.elsewhere.origin ?? 'manual',
            capture: {
              source: lineage.elsewhere.capture ?? 'manual-action',
              confidence: 'explicit'
            }
          }
        }
      : {})
  } as unknown as RuntimeWorktreePsSummary
}

function makeHost(
  rows: RuntimeWorktreePsSummary[],
  recorded: {
    lineage?: Record<string, unknown>
    parents?: Record<string, unknown>
    crossStore?: Record<string, unknown>
    botHomes?: string[]
    /** Each paired server's workspaces with a parent elsewhere, or null for one that doesn't answer. */
    paired?: Record<string, RuntimeWorktreePsSummary[] | null>
  } = {}
): {
  runtime: OrcaRuntimeService
  store: RuntimeStore
} {
  const repos = [...new Set(rows.map((summary) => summary.repoId))].map((id) => ({
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '',
    addedAt: 0
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the evidence read uses only these store members.
  const store = {
    getRepos: () => repos,
    getSettings: () => ({ workspaceCleanupPolicy: RULES }),
    getWorkspaceSession: () => undefined,
    getWorktreeMeta: () => undefined,
    getAllWorkspaceLineage: () => recorded.lineage ?? {},
    getAllWorktreeLineage: () => recorded.parents ?? {},
    getAllCrossStoreWorkspaceLineage: () => recorded.crossStore ?? {},
    getBots: () => (recorded.botHomes ?? []).map((folderWorkspaceId) => ({ folderWorkspaceId }))
  } as unknown as RuntimeStore
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the evidence read uses only these runtime members.
  const runtime = {
    getWorktreePs: async (_limit: number, _a: boolean, _b: boolean, worktreeId?: string) => ({
      worktrees: rows.filter((summary) => !worktreeId || summary.worktreeId === worktreeId),
      truncated: false
    }),
    getExistingOrchestrationDb: () => null,
    listTerminals: async () => ({ terminals: [], totalCount: 0, truncated: false }),
    getLocalProvider: () => ({ listProcesses: async () => [] }),
    removeManagedWorktree: vi.fn(),
    getRuntimeId: () => 'runtime-1',
    listOrchestrationWorkerServers: async () =>
      Object.keys(recorded.paired ?? {}).map((environmentId) => ({ environmentId, name: '' })),
    callOrchestrationWorkerServer: vi.fn(async (environmentId: string) => {
      const answer = recorded.paired?.[environmentId]
      if (!answer) {
        throw new Error('timed out')
      }
      // Its saved cross-store links, as `worktree.lineageList` answers.
      const crossStoreLineage = Object.fromEntries(
        answer.map((child) => [
          `worktree:${child.worktreeId}`,
          {
            childWorkspaceKey: `worktree:${child.worktreeId}`,
            childInstanceId: 'child-instance',
            createdAt: 0,
            ...child.crossStoreParent
          }
        ])
      )
      return { crossStoreLineage }
    })
  } as unknown as OrcaRuntimeService
  return { runtime, store }
}

function makeRunner(
  rows: RuntimeWorktreePsSummary[],
  recorded?: Parameters<typeof makeHost>[1]
): WorkspaceCleanupRunner {
  return new WorkspaceCleanupRunner({
    ...makeHost(rows, recorded),
    historyDirectory: '/nonexistent'
  })
}

async function verdicts(runner: WorkspaceCleanupRunner): Promise<Record<string, unknown>> {
  const preview = await runner.preview(RULES)
  return Object.fromEntries(preview.rows.map((r) => [r.worktreeId, r.evaluation]))
}

describe('folder workspace cleanup group', () => {
  beforeEach(() => dirty.clear())

  it('keeps every worktree of a folder workspace while one of them is still in use', async () => {
    dirty.add('repo-c::/c1')
    const runner = makeRunner([
      row('repo-a::/a1', { folder: 'F' }),
      row('repo-b::/b1', { folder: 'F' }),
      // Listed under F through its parent, as Source Control nests it.
      row('repo-c::/c1', { parent: 'repo-b::/b1' }),
      row('repo-a::/g1', { folder: 'G' }),
      row('repo-b::/g2', { folder: 'G' }),
      row('repo-a::/solo')
    ])
    expect(await verdicts(runner)).toEqual({
      'repo-a::/a1': { action: 'keep', cause: 'folder-workspace-sibling', reason: 'merged' },
      'repo-b::/b1': { action: 'keep', cause: 'folder-workspace-sibling', reason: 'merged' },
      'repo-c::/c1': { action: 'keep', cause: 'uncommitted-changes', reason: 'merged' },
      'repo-a::/g1': { action: 'delete', reason: 'merged' },
      'repo-b::/g2': { action: 'delete', reason: 'merged' },
      'repo-a::/solo': { action: 'delete', reason: 'merged' }
    })
  })

  it('keeps the group while a sibling cannot be judged on this host', async () => {
    const runner = makeRunner(
      [
        row('repo-a::/a1', { folder: 'F' }),
        row('repo-b::/b1', { folder: 'F' }),
        // Same id, another machine's checkout.
        row('repo-b::/b1', { folder: 'F', hostId: 'ssh:remote' }),
        row('repo-a::/h1', { folder: 'H' })
      ],
      // h1's lineage child h2 is missing: its repo's scan failed.
      {
        lineage: {
          'worktree:repo-a::/h1': {
            childWorkspaceKey: 'worktree:repo-a::/h1',
            parentWorkspaceKey: 'folder:H'
          }
        },
        parents: { 'repo-c::/h2': { parentWorktreeId: 'repo-a::/h1' } }
      }
    )
    expect(await verdicts(runner)).toEqual({
      'repo-a::/a1': { action: 'keep', cause: 'folder-workspace-sibling', reason: 'merged' },
      'repo-b::/b1': { action: 'keep', cause: 'folder-workspace-sibling', reason: 'merged' },
      'repo-a::/h1': { action: 'keep', cause: 'folder-workspace-sibling', reason: 'merged' }
    })
  })

  it("cleans a bot's workspaces one by one", async () => {
    dirty.add('repo-b::/t2')
    const runner = makeRunner(
      [row('repo-a::/t1', { folder: 'home' }), row('repo-b::/t2', { folder: 'home' })],
      { botHomes: ['home'] }
    )
    expect(await verdicts(runner)).toEqual({
      'repo-a::/t1': { action: 'delete', reason: 'merged' },
      'repo-b::/t2': { action: 'keep', cause: 'uncommitted-changes', reason: 'merged' }
    })
  })

  it('re-checks the folder as listed at removal time, not as the scan saw it', async () => {
    const rows = [row('repo-a::/a1', { folder: 'F' }), row('repo-b::/b1', { folder: 'F' })]
    const host = makeHost(rows)
    const scanned = await collectWorkspaceCleanupWorkspaces({ ...host, globalRules: RULES, now: 1 })
    // Created in F while the run was removing other workspaces.
    rows.push(row('repo-c::/n1', { folder: 'F' }))
    dirty.add('repo-c::/n1')

    const outcome = await removeWorkspaceForCleanup({
      ...host,
      globalRules: () => RULES,
      workspace: scanned.find((workspace) => workspace.ref.worktreeId === 'repo-a::/a1')!,
      now: () => Date.UTC(2026, 10, 19)
    })

    expect(outcome).toEqual({
      outcome: 'kept',
      keepCause: 'folder-workspace-sibling',
      reason: 'merged',
      keptOnRecheck: true
    })
    expect(host.runtime.removeManagedWorktree).not.toHaveBeenCalled()
  })

  it('holds a worktree whose parent is in another Orca store', async () => {
    const runner = makeRunner(
      [
        row('repo-a::/r1', { elsewhere: { store: 'desktop', key: 'folder:F' } }),
        // Nested under r1, so in the same folder.
        row('repo-b::/r2', { parent: 'repo-a::/r1' }),
        // Its parent worktree there may be in a folder.
        row('repo-a::/r3', { elsewhere: { store: 'desktop', key: 'worktree:repo-d::/d1' } }),
        // Workers' checkouts and a bot's hand-overs aren't held by a folder's other members.
        row('repo-a::/w1', {
          elsewhere: { store: 'desktop', key: 'folder:F', origin: 'orchestration' }
        }),
        row('repo-c::/w2', { parent: 'repo-a::/r1' }),
        row('repo-a::/h1', {
          elsewhere: { store: 'desktop', key: 'folder:Bot', capture: 'bot-hand-over' }
        }),
        // Its parent p1, missing from the listing, is attached to a folder there.
        row('repo-b::/r4', { parent: 'repo-e::/p1' })
      ],
      {
        parents: { 'repo-c::/w2': { parentWorktreeId: 'repo-a::/r1', origin: 'orchestration' } },
        crossStore: {
          'worktree:repo-e::/p1': {
            parent: { installationId: 'desktop', workspaceKey: 'folder:F' },
            origin: 'manual',
            capture: { source: 'manual-action' }
          }
        }
      }
    )
    expect(await verdicts(runner)).toEqual({
      'repo-a::/r1': { action: 'keep', cause: 'folder-workspace-sibling', reason: 'merged' },
      'repo-b::/r2': { action: 'keep', cause: 'folder-workspace-sibling', reason: 'merged' },
      'repo-a::/r3': { action: 'keep', cause: 'folder-workspace-sibling', reason: 'merged' },
      'repo-a::/w1': { action: 'delete', reason: 'merged' },
      'repo-c::/w2': { action: 'delete', reason: 'merged' },
      'repo-a::/h1': { action: 'delete', reason: 'merged' },
      'repo-b::/r4': { action: 'keep', cause: 'folder-workspace-sibling', reason: 'merged' }
    })
  })

  it("holds this store's folder while a paired server has a workspace in it", async () => {
    const runner = makeRunner(
      [
        row('repo-a::/a1', { folder: 'F' }),
        row('repo-a::/g1', { folder: 'G', instance: 'g1-instance' }),
        row('repo-a::/k1', { folder: 'K' })
      ],
      {
        paired: {
          'env-r': [
            row('repo-x::/x1', { elsewhere: { store: 'this-store', key: 'folder:F' } }),
            // A worker's checkout there doesn't hold K.
            row('repo-x::/x3', {
              elsewhere: { store: 'this-store', key: 'folder:K', origin: 'orchestration' }
            }),
            // Its parent g1 was renamed after the link was saved.
            row('repo-x::/x2', {
              elsewhere: {
                store: 'this-store',
                key: 'worktree:repo-a::/old',
                instance: 'g1-instance'
              }
            })
          ]
        }
      }
    )
    expect(await verdicts(runner)).toEqual({
      'repo-a::/a1': { action: 'keep', cause: 'folder-workspace-sibling', reason: 'merged' },
      'repo-a::/g1': { action: 'keep', cause: 'folder-workspace-sibling', reason: 'merged' },
      'repo-a::/k1': { action: 'delete', reason: 'merged' }
    })
  })

  it('holds every folder group while a paired server does not answer', async () => {
    const runner = makeRunner([row('repo-a::/a1', { folder: 'F' }), row('repo-a::/solo')], {
      paired: { 'env-r': null }
    })
    expect(await verdicts(runner)).toEqual({
      'repo-a::/a1': { action: 'keep', cause: 'folder-workspace-sibling', reason: 'merged' },
      'repo-a::/solo': { action: 'delete', reason: 'merged' }
    })
  })
})
