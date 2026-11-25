import { beforeEach, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import type { RuntimeWorktreePsSummary } from '../../../shared/worktree/catalog/runtime-worktree-contracts'
import type { WorkspaceCleanupRules } from '../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type * as CheckoutIdentityModule from '../removal/worktree-checkout-identity'

// Git evidence is the scan's job; every listed checkout here is merged and clean.
vi.mock('../../ipc/workspace-cleanup/workspace-cleanup-scan', () => ({
  scanWorkspaceCleanup: async (
    _store: unknown,
    _args: unknown,
    options: { targetWorktreeIds: string[] }
  ) => ({
    errors: [],
    candidates: options.targetWorktreeIds.map((worktreeId) => ({
      worktreeId,
      executionHostId: 'local',
      reasons: ['merged'],
      blockers: [],
      lastActivityAt: 0,
      git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 1 }
    }))
  })
}))
// The listed checkouts are synthetic paths; the on-disk identity proof has its own tests.
vi.mock('../removal/worktree-checkout-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof CheckoutIdentityModule>()),
  captureWorktreeCheckoutIdentity: async () => undefined
}))
vi.mock('../../runtime/hosts/platform-probe/host-descriptor', () => ({
  readCallerStoreInstallationId: async () => 'this-store'
}))
vi.mock('../../persistence/loading-store/user-data-path', () => ({
  getCanonicalUserDataPath: () => '/nonexistent'
}))

import { WorkspaceCleanupRunner } from './workspace-cleanup-runner'
import { listMissingSiblingProjectsStrictly } from './workspace-cleanup-sibling-inventory'
import type { Repo } from '../../../shared/repository/repo-types'

const RULES: WorkspaceCleanupRules = {
  merged: { enabled: true },
  unchanged: { enabled: false, afterDays: 1 },
  inactive: { enabled: false, afterDays: 30, action: 'delete' },
  automationRuns: { enabled: false },
  orchestrationWorkers: { enabled: false },
  keepWhen: 'any-local-files'
}

function row(worktreeId: string, folder = true): RuntimeWorktreePsSummary {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: cleanup reads only these listing fields.
  return {
    workspaceKind: 'git',
    worktreeId,
    repoId: worktreeId.split('::')[0],
    path: worktreeId.split('::')[1],
    branch: 'refs/heads/feature',
    displayName: worktreeId,
    isArchived: false,
    isMainWorktree: false,
    isPinned: false,
    isActive: false,
    unverifiableTerminalCount: 0,
    agents: [],
    parentWorktreeId: null,
    workspaceLineage: folder ? { parentWorkspaceKey: 'folder:F' } : null
  } as unknown as RuntimeWorktreePsSummary
}

const calls: { repoId?: string; fresh?: boolean | readonly string[] }[] = []
beforeEach(() => {
  calls.length = 0
})

/** A runner over these listed rows; `listing` answers getWorktreePs as the real catalog would. */
function makeRunner(
  rows: RuntimeWorktreePsSummary[],
  listing: (repoId?: string, fresh?: boolean | readonly string[]) => RuntimeWorktreePsSummary[],
  repoPaths: Record<string, string> = {}
): WorkspaceCleanupRunner {
  const repos = [...new Set(rows.map((summary) => summary.repoId))].map((id) => ({
    id,
    path: repoPaths[id] ?? `/${id}`,
    displayName: id,
    badgeColor: '',
    addedAt: 0,
    ...(id === 'repo-a' ? { workspaceCleanupPolicy: { mode: 'off' as const } } : {})
  }))
  const folderMembers = rows.filter((summary) => summary.workspaceLineage)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the evidence read uses only these store members.
  const store = {
    getRepos: () => repos,
    getSettings: () => ({ workspaceCleanupPolicy: RULES }),
    getWorkspaceSession: () => undefined,
    getWorktreeMeta: () => undefined,
    getAllWorkspaceLineage: () =>
      Object.fromEntries(
        folderMembers.map((summary) => [
          `worktree:${summary.worktreeId}`,
          { childWorkspaceKey: `worktree:${summary.worktreeId}`, parentWorkspaceKey: 'folder:F' }
        ])
      ),
    getAllWorktreeLineage: () => ({}),
    getAllCrossStoreWorkspaceLineage: () => ({}),
    getBots: () => []
  } as unknown as RuntimeStore
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the evidence read uses only these runtime members.
  const runtime = {
    getWorktreePs: async (
      _limit: number,
      _a: boolean,
      _b: boolean,
      _worktreeId?: string,
      repoId?: string,
      fresh?: boolean | readonly string[]
    ) => {
      calls.push({ repoId, fresh })
      return { worktrees: listing(repoId, fresh), truncated: false }
    },
    getExistingOrchestrationDb: () => null,
    listTerminals: async () => ({ terminals: [], totalCount: 0, truncated: false }),
    getLocalProvider: () => ({ listProcesses: async () => [] }),
    getRuntimeId: () => 'runtime-1',
    listOrchestrationWorkerServers: async () => []
  } as unknown as OrcaRuntimeService
  return new WorkspaceCleanupRunner({ store, runtime, historyDirectory: '/nonexistent' })
}
const turnOn = (runner: WorkspaceCleanupRunner) =>
  runner.previewChange(
    { scope: 'project', repoId: 'repo-a', policy: null },
    runner.readPolicy('repo-a').state,
    true
  )

it("fails a project's preview when its folder sibling's project could not be listed", async () => {
  const rows = [row('repo-a::/a1'), row('repo-b::/b1')]
  // repo-b's listing fails: an ordinary listing omits its rows, a strict one refuses.
  const runner = makeRunner(rows, (repoId, fresh) => {
    if (Array.isArray(fresh) && fresh.includes('repo-b')) {
      throw new Error('Could not list every workspace on this host.')
    }
    return rows.filter((summary) =>
      repoId ? summary.repoId === repoId : summary.repoId !== 'repo-b'
    )
  })
  // Turning repo-a back on would free the folder group, repo-b's worktree included: consent must see it.
  await expect(turnOn(runner)).rejects.toThrow('Could not list every workspace on this host.')
  // One inventory, complete for exactly the missing member's project.
  expect(calls.filter((call) => Array.isArray(call.fresh))).toEqual([{ fresh: ['repo-b'] }])
})

it("leaves a paired server's member to that server, even beside a same-id local project", async () => {
  const getWorktreePs = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the listing call is under test.
  const runtime = { getWorktreePs } as unknown as OrcaRuntimeService
  const listed = [row('repo-a::/a1')]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the strict re-list reads only the map's keys.
  const repos = new Map([['repo-b', { id: 'repo-b' } as Repo]])
  const result = await listMissingSiblingProjectsStrictly(runtime, listed, 'repo-a', repos, () => [
    'runtime:env-1|repo-b::/b1'
  ])
  expect(result).toBe(listed)
  expect(getWorktreePs).not.toHaveBeenCalled()
})

it("reviews a healthy folder group while an unrelated project's listing fails", async () => {
  const rows = [row('repo-a::/a1'), row('repo-b::/b1'), row('repo-c::/c1', false)]
  // repo-c's folder is missing: its listing fails strictly and drops out of an ordinary listing.
  const runner = makeRunner(rows, (repoId, fresh) => {
    if (fresh === true ? !repoId : Array.isArray(fresh) && fresh.includes('repo-c')) {
      throw new Error('Could not list every workspace on this host.')
    }
    return rows.filter(
      (summary) => summary.repoId !== 'repo-c' && (!repoId || summary.repoId === repoId)
    )
  })
  const { next } = await turnOn(runner)
  expect(
    Object.fromEntries(next.rows.map((preview) => [preview.worktreeId, preview.evaluation]))
  ).toEqual({
    'repo-a::/a1': { action: 'delete', reason: 'merged' },
    'repo-b::/b1': { action: 'delete', reason: 'merged' }
  })
})

it('keeps a WSL-routed checkout out of the deletions a preview lists', async () => {
  const rows = [row('repo-a::/a1', false), row('repo-a::/a2', false)]
  const runner = makeRunner(
    rows,
    (repoId) => rows.filter((summary) => !repoId || summary.repoId === repoId),
    { 'repo-a': '\\\\wsl.localhost\\Ubuntu\\repo-a' }
  )
  const { next } = await turnOn(runner)
  // Guarded removal refuses this route, so the change offers nothing for deletion here.
  expect(next.rows.map((preview) => preview.evaluation)).toEqual([
    { action: 'keep', cause: 'identity-unverified', reason: 'merged' },
    { action: 'keep', cause: 'identity-unverified', reason: 'merged' }
  ])
})
