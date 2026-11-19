import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import type { WorkspaceCleanupBlocker } from '../../../shared/workspace-cleanup/workspace-cleanup'
import type { WorkspaceCleanupWorkspace } from './workspace-cleanup-run-evidence'

const { collect, queueDelete } = vi.hoisted(() => ({
  collect: vi.fn(),
  queueDelete: vi.fn()
}))

vi.mock('./workspace-cleanup-run-evidence', () => ({
  collectWorkspaceCleanupWorkspaces: collect
}))
vi.mock('./workspace-cleanup-terminal-activity', () => ({
  readWorkspaceCleanupTerminalActivity: async () => 'idle'
}))
vi.mock('../../workspace-hooks/hooks', () => ({ getEffectiveHooks: () => null }))
vi.mock('../../runtime/workspaces/lifecycle/workspace-lifecycle-commands', () => ({
  queueWorkspaceDelete: queueDelete,
  queueWorkspaceArchive: vi.fn()
}))

import { removeWorkspaceForCleanup } from './workspace-cleanup-removal-step'

const NOW = Date.UTC(2026, 10, 12)
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every module that reads the runtime or store is mocked above.
const host = {} as { runtime: OrcaRuntimeService; store: RuntimeStore }

function merged(
  worktreeId: string,
  folderSiblings: string[],
  blockers: WorkspaceCleanupBlocker[] = []
): WorkspaceCleanupWorkspace {
  const repoId = worktreeId.split('::')[0]
  return {
    ref: { worktreeId, repoId, repoName: repoId, displayName: worktreeId, branch: 'b', path: '/w' },
    repo: { id: repoId, path: `/${repoId}`, displayName: repoId, badgeColor: '', addedAt: 0 },
    policy: {
      source: 'global',
      inactiveActionSupported: false,
      rules: {
        merged: { enabled: true },
        unchanged: { enabled: false, afterDays: 1 },
        inactive: { enabled: false, afterDays: 30, action: 'delete' },
        automationRuns: { enabled: false },
        orchestrationWorkers: { enabled: false },
        keepWhen: 'any-local-files'
      }
    },
    input: {
      reasons: ['merged'],
      blockers,
      lastActivityAt: NOW - 2 * 24 * 60 * 60 * 1000,
      git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: NOW }
    },
    paneAgentStates: new Map(),
    removing: false,
    identity: `local|${worktreeId}`,
    folderSiblings
  }
}

describe('removeWorkspaceForCleanup', () => {
  beforeEach(() => {
    collect.mockReset()
    queueDelete.mockReset().mockResolvedValue({})
  })

  it('keeps a worktree when its folder sibling picked up work after the scan', async () => {
    const fresh = new Map([
      ['repo-a::a1', merged('repo-a::a1', [])],
      ['repo-b::b1', merged('repo-b::b1', [], ['dirty-files'])]
    ])
    collect.mockImplementation(async ({ worktreeId }: { worktreeId: string }) => [
      fresh.get(worktreeId)
    ])

    const outcome = await removeWorkspaceForCleanup({
      ...host,
      globalRules: () => merged('repo-a::a1', []).policy.rules,
      workspace: merged('repo-a::a1', ['local|repo-b::b1']),
      now: () => NOW
    })

    expect(outcome).toEqual({
      outcome: 'kept',
      keepCause: 'folder-workspace-sibling',
      reason: 'merged',
      keptOnRecheck: true
    })
    expect(queueDelete).not.toHaveBeenCalled()
  })
})
