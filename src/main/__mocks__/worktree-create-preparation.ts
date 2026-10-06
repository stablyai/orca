import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import type * as WorktreeLogic from '../ipc/worktree-logic'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/repo-types'
import { resolveWorktreeAddBaseRef } from '../../shared/worktree/base-ref'

const mocks: {
  mkdir: Mock
  listWorktreeGraph: Mock
  prepareCheckout: Mock
  refreshTip: Mock
  finalize: Mock
  discard: Mock
  unlock: Mock
  getWorktreeOptions: Mock
  computeWorkspaceRoot: Mock
  computeWorkspaceRootAsync: Mock
  resolveBaseRef: Mock
  measureDivergence: Mock
} = vi.hoisted(() => ({
  mkdir: vi.fn(),
  listWorktreeGraph: vi.fn(),
  prepareCheckout: vi.fn(),
  refreshTip: vi.fn(),
  finalize: vi.fn(),
  discard: vi.fn(),
  unlock: vi.fn(),
  getWorktreeOptions: vi.fn(),
  computeWorkspaceRoot: vi.fn(),
  computeWorkspaceRootAsync: vi.fn(),
  resolveBaseRef: vi.fn(),
  measureDivergence: vi.fn()
}))

export { mocks }

vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir }))
vi.mock('../git/worktree', () => ({ listWorktreeGraph: mocks.listWorktreeGraph }))
vi.mock('../git/worktree-create-preparation', () => ({
  prepareWorktreeCreateCheckout: mocks.prepareCheckout,
  finalizePreparedWorktree: mocks.finalize,
  discardPreparedWorktree: mocks.discard,
  unlockPreparedWorktree: mocks.unlock
}))
vi.mock('../git/worktree-preparation-tip-refresh', () => ({
  refreshPreparedWorktreeTip: mocks.refreshTip
}))
vi.mock('../git/worktree-base-ref-probe', () => ({
  resolveLocalWorktreeBaseRef: mocks.resolveBaseRef
}))
vi.mock('../git/worktree-base-divergence', () => ({
  measureRetargetDivergence: mocks.measureDivergence
}))
vi.mock('../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: mocks.getWorktreeOptions,
  getWorktreeMirrorDistro: () => undefined
}))
vi.mock('../ipc/worktree-logic', async (importOriginal) => ({
  isOrphanedWorktreeError: (await importOriginal<typeof WorktreeLogic>()).isOrphanedWorktreeError,
  computeWorkspaceRoot: mocks.computeWorkspaceRoot,
  computeWorkspaceRootAsync: mocks.computeWorkspaceRootAsync,
  getWorktreePathSettings: () => ({
    workspaceDir: process.platform === 'win32' ? 'C:\\workspace' : '/workspace',
    nestWorkspaces: false
  })
}))

import { _resetWorktreeCreatePreparationsForTests } from '../worktree-create-preparation'

// Evictions and retries are fire-and-forget, so let them settle before asserting.
export function flushBackgroundWork(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const EXISTING_REFS = new Set([
  'refs/heads/main',
  'refs/remotes/origin/main',
  'refs/remotes/origin/release'
])
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked flow reads only this repository identity.
export const repo = { id: 'repo-1', path: '/repo' } as Repo
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked persistence boundary reads only getSettings.
export const store = { getSettings: () => ({}) } as unknown as Store

beforeEach(() => {
  mocks.mkdir.mockReset().mockResolvedValue(undefined)
  mocks.listWorktreeGraph.mockReset().mockResolvedValue([])
  mocks.prepareCheckout.mockReset().mockResolvedValue(undefined)
  mocks.refreshTip.mockReset().mockResolvedValue(undefined)
  mocks.finalize.mockReset().mockResolvedValue({})
  mocks.discard.mockReset().mockResolvedValue(undefined)
  mocks.unlock.mockReset().mockResolvedValue(undefined)
  mocks.getWorktreeOptions.mockReset().mockReturnValue({})
  mocks.measureDivergence.mockReset().mockResolvedValue('within')
  mocks.resolveBaseRef
    .mockReset()
    .mockImplementation((_repoPath: string, baseRef: string) =>
      resolveWorktreeAddBaseRef(baseRef, async (candidate) => EXISTING_REFS.has(candidate))
    )
  mocks.computeWorkspaceRoot.mockReset().mockImplementation(() => {
    throw new Error('synchronous workspace-root lookup must not run on the main thread')
  })
  mocks.computeWorkspaceRootAsync
    .mockReset()
    .mockImplementation(async (repoPath: string) =>
      process.platform === 'win32' && /^[A-Za-z]:[\\/]/.test(repoPath)
        ? 'C:\\workspace'
        : '/workspace'
    )
})

afterEach(async () => {
  await _resetWorktreeCreatePreparationsForTests()
})
