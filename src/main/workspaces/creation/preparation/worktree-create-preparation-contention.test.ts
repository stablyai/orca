import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../../../persistence/loading-store/store'
import type { Repo } from '../../../../shared/repo-types'

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  listWorktreeGraph: vi.fn(),
  prepare: vi.fn(),
  finalize: vi.fn(),
  discard: vi.fn(),
  computeWorkspaceRootAsync: vi.fn(),
  getWorktreeOptions: vi.fn(),
  resolveBaseRef: vi.fn(),
  measureDivergence: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir }))

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorktreeGraph: mocks.listWorktreeGraph
}))
vi.mock('../../../git/worktrees/creation/worktree-create-preparation', () => ({
  prepareWorktreeCreateCheckout: mocks.prepare,
  finalizePreparedWorktree: mocks.finalize,
  discardPreparedWorktree: mocks.discard,
  unlockPreparedWorktree: vi.fn()
}))
vi.mock('../../../git/worktrees/creation/worktree-base-ref-probe', () => ({
  resolveLocalWorktreeBaseRef: mocks.resolveBaseRef
}))
vi.mock('../../../git/worktrees/creation/worktree-base-divergence', () => ({
  measureRetargetDivergence: mocks.measureDivergence
}))
vi.mock('../../execution-host/project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: mocks.getWorktreeOptions,
  getWorktreeMirrorDistro: () => undefined
}))
vi.mock('../../../ipc/worktree-logic', () => ({
  computeWorkspaceRootAsync: mocks.computeWorkspaceRootAsync,
  getWorktreePathSettings: () => ({ workspaceDir: '/workspace', nestWorkspaces: false })
}))

import {
  _resetWorktreeCreatePreparationsForTests,
  consumePreparedWorktreeCreate,
  hasPendingWorktreeCreatePreparations,
  prepareWorktreeCreateForRepo
} from './worktree-create-preparation'
import './worktree-create-preparation-pool'
import './worktree-create-preparation-claim-registry'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: 'blue',
  addedAt: 0
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The tested path reads only getSettings from Store.
const store = { getSettings: () => ({}) } as unknown as Store

function consume(baseBranch = 'origin/main') {
  return consumePreparedWorktreeCreate({
    repoPath: repo.path,
    workspaceRoot: '/workspace',
    worktreePath: '/workspace/new-worktree',
    branch: 'feature/new-worktree',
    baseBranch
  })
}

beforeEach(() => {
  mocks.mkdir.mockReset().mockResolvedValue(undefined)
  mocks.listWorktreeGraph.mockReset().mockResolvedValue([])
  mocks.prepare.mockReset().mockResolvedValue(undefined)
  mocks.finalize.mockReset().mockResolvedValue({})
  mocks.discard.mockReset().mockResolvedValue(undefined)
  mocks.computeWorkspaceRootAsync.mockReset().mockResolvedValue('/workspace')
  mocks.getWorktreeOptions.mockReset().mockReturnValue({})
  mocks.resolveBaseRef
    .mockReset()
    .mockImplementation(async (_path: string, base: string) =>
      base === 'main'
        ? 'refs/heads/main'
        : base === 'other/main'
          ? 'refs/remotes/other/main'
          : 'refs/remotes/origin/main'
    )
  mocks.measureDivergence.mockReset().mockResolvedValue('within')
})

afterEach(async () => {
  await _resetWorktreeCreatePreparationsForTests()
})

describe('claimed worktree preparation', () => {
  it('does not let two creates claim the same prepared checkout', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const [first, second] = await Promise.all([consume(), consume()])

    expect([first.status, second.status].sort()).toEqual(['hit', 'miss'])
    expect(mocks.finalize).toHaveBeenCalledOnce()
    expect(hasPendingWorktreeCreatePreparations()).toBe(true)
    first.rearm?.()
    second.rearm?.()
    expect(hasPendingWorktreeCreatePreparations()).toBe(false)
  })
})
