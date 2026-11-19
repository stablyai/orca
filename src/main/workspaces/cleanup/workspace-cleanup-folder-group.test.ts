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

import { WorkspaceCleanupRunner } from './workspace-cleanup-runner'

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
  lineage: { folder?: string; parent?: string; hostId?: string } = {}
): RuntimeWorktreePsSummary {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: cleanup reads only these listing fields.
  return {
    workspaceKind: 'git',
    worktreeId,
    repoId: worktreeId.split('::')[0],
    ...(lineage.hostId ? { hostId: lineage.hostId } : {}),
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
    workspaceLineage: lineage.folder ? { parentWorkspaceKey: `folder:${lineage.folder}` } : null
  } as unknown as RuntimeWorktreePsSummary
}

function makeRunner(rows: RuntimeWorktreePsSummary[]): WorkspaceCleanupRunner {
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
    getWorkspaceSession: () => undefined
  } as unknown as RuntimeStore
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the evidence read uses only these runtime members.
  const runtime = {
    getWorktreePs: async (_limit: number, _a: boolean, _b: boolean, worktreeId?: string) => ({
      worktrees: rows.filter((summary) => !worktreeId || summary.worktreeId === worktreeId),
      truncated: false
    }),
    getExistingOrchestrationDb: () => null,
    listTerminals: async () => ({ terminals: [], totalCount: 0, truncated: false }),
    getLocalProvider: () => ({ listProcesses: async () => [] })
  } as unknown as OrcaRuntimeService
  return new WorkspaceCleanupRunner({ runtime, store, historyDirectory: '/nonexistent' })
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

  it('keeps the group when a sibling lives on another host, even under the same id', async () => {
    const runner = makeRunner([
      row('repo-a::/a1', { folder: 'F' }),
      row('repo-b::/b1', { folder: 'F' }),
      row('repo-b::/b1', { folder: 'F', hostId: 'ssh:remote' })
    ])
    expect(await verdicts(runner)).toEqual({
      'repo-a::/a1': { action: 'keep', cause: 'folder-workspace-sibling', reason: 'merged' },
      'repo-b::/b1': { action: 'keep', cause: 'folder-workspace-sibling', reason: 'merged' }
    })
  })
})
