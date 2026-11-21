import type * as PolicyPreview from './workspace-cleanup-policy-preview'
import { beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceCleanupRunner } from './workspace-cleanup-runner'
import { getDefaultWorkspaceCleanupRules } from '../../../shared/workspace-cleanup/workspace-cleanup-policy'
const { collect, oldRead, finishOld } = vi.hoisted(() => ({
  collect: vi.fn(),
  oldRead: Promise.withResolvers<void>(),
  finishOld: Promise.withResolvers<void>()
}))
vi.mock('./workspace-cleanup-run-evidence', () => ({ collectWorkspaceCleanupWorkspaces: collect }))
vi.mock('./workspace-cleanup-policy-preview', async (original) => ({
  ...(await original<typeof PolicyPreview>()),
  readWorkspaceCleanupSizes: async () => new Map()
}))
beforeEach(() => {
  collect.mockReset()
})
it('samples a newly eligible workspace in a post-click comparison while an older comparison is deferred', async () => {
  const rules = { ...getDefaultWorkspaceCleanupRules(), merged: { enabled: true } }
  const repo = {
    id: 'repo',
    path: '/fixture',
    displayName: 'Fixture',
    badgeColor: 'gray',
    addedAt: 1
  }
  const store = {
    getSettings: () => ({ workspaceCleanupPolicy: rules }),
    getRepos: () => [],
    getProfileStorageDirectory: () => '/fixture'
  }
  let eligible = false
  collect.mockImplementation(async () => {
    const sampled = eligible
    if (!sampled) {
      oldRead.resolve()
      await finishOld.promise
    }
    return sampled
      ? [
          {
            ref: {
              worktreeId: 'repo::/fixture/work',
              instanceId: 'a',
              repoId: 'repo',
              repoName: 'Fixture',
              displayName: 'New',
              branch: 'topic',
              path: '/fixture/work'
            },
            repo,
            policy: { rules },
            nextPolicy: { rules },
            paneAgentStates: new Map(),
            removing: false,
            identity: 'repo::/fixture/work',
            folderSiblings: [],
            input: {
              reasons: ['merged'],
              blockers: [],
              lastActivityAt: 1,
              git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 1 }
            }
          }
        ]
      : []
  })
  const runtime = {
    listTerminals: async () => ({ terminals: [], truncated: false }),
    getLocalProvider: () => ({ listProcesses: async () => [] })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the owner reads and terminal boundary; runner generation and evaluator are real.
  const deps = { store, runtime, historyDirectory: '/fixture' } as never
  const runner = new WorkspaceCleanupRunner(deps)
  const state = runner.readPolicy(null).state
  const change = { scope: 'global' as const, rules }
  const older = runner.previewChange(change, state)
  await oldRead.promise
  eligible = true
  const confirmation = await runner.previewChange(change, state, true)
  expect(confirmation.next.rows.map((row) => row.displayName)).toEqual(['New'])
  expect(confirmation.next.rows[0].evaluation).toEqual({ action: 'delete', reason: 'merged' })
  finishOld.resolve()
  expect((await older).next.rows).toEqual([])
})
