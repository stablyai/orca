import { expect, it, vi } from 'vitest'
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

const RULES: WorkspaceCleanupRules = {
  merged: { enabled: true },
  unchanged: { enabled: false, afterDays: 1 },
  inactive: { enabled: false, afterDays: 30, action: 'delete' },
  automationRuns: { enabled: false },
  orchestrationWorkers: { enabled: false },
  keepWhen: 'any-local-files'
}

function row(worktreeId: string): RuntimeWorktreePsSummary {
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
    workspaceLineage: { parentWorkspaceKey: 'folder:F' }
  } as unknown as RuntimeWorktreePsSummary
}

it("fails a project's preview when its folder sibling's project could not be listed", async () => {
  const rows = [row('repo-a::/a1'), row('repo-b::/b1')]
  const repos = ['repo-a', 'repo-b'].map((id) => ({
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '',
    addedAt: 0,
    ...(id === 'repo-a' ? { workspaceCleanupPolicy: { mode: 'off' as const } } : {})
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the evidence read uses only these store members.
  const store = {
    getRepos: () => repos,
    getSettings: () => ({ workspaceCleanupPolicy: RULES }),
    getWorkspaceSession: () => undefined,
    getWorktreeMeta: () => undefined,
    getAllWorkspaceLineage: () =>
      Object.fromEntries(
        rows.map((summary) => [
          `worktree:${summary.worktreeId}`,
          { childWorkspaceKey: `worktree:${summary.worktreeId}`, parentWorkspaceKey: 'folder:F' }
        ])
      ),
    getAllWorktreeLineage: () => ({}),
    getAllCrossStoreWorkspaceLineage: () => ({}),
    getBots: () => []
  } as unknown as RuntimeStore
  // repo-b's listing fails: an ordinary listing omits its rows, a strict one refuses.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the evidence read uses only these runtime members.
  const runtime = {
    getWorktreePs: async (
      _limit: number,
      _a: boolean,
      _b: boolean,
      _worktreeId?: string,
      repoId?: string,
      fresh?: boolean
    ) => {
      if (!repoId && fresh) {
        throw new Error('Could not list every workspace on this host.')
      }
      return {
        worktrees: rows.filter((summary) =>
          repoId ? summary.repoId === repoId : summary.repoId !== 'repo-b'
        ),
        truncated: false
      }
    },
    getExistingOrchestrationDb: () => null,
    listTerminals: async () => ({ terminals: [], totalCount: 0, truncated: false }),
    getLocalProvider: () => ({ listProcesses: async () => [] }),
    getRuntimeId: () => 'runtime-1',
    listOrchestrationWorkerServers: async () => []
  } as unknown as OrcaRuntimeService
  const runner = new WorkspaceCleanupRunner({ store, runtime, historyDirectory: '/nonexistent' })
  const read = runner.readPolicy('repo-a')
  // Turning repo-a back on would free the folder group, repo-b's worktree included: consent must see it.
  await expect(
    runner.previewChange({ scope: 'project', repoId: 'repo-a', policy: null }, read.state, true)
  ).rejects.toThrow('Could not list every workspace on this host.')
})
