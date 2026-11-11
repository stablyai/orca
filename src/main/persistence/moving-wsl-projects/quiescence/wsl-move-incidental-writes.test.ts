import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { mergeWorktreeMetaForWrite } from '../../loading-store/worktree-metadata/worktree-meta-write-normalization'
import { wslMoveCutoverFixture as cutover } from '../../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { loadWslMoveFence, resetWslMoveFenceForTests } from './wsl-move-scope-guard'
import type * as LinearCurrentIssueContext from '../../../linear/issues/context/worktree-current-issue'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))
vi.mock('../../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))
vi.mock('../../../linear/issues/context/worktree-current-issue', async (importOriginal) => ({
  ...(await importOriginal<typeof LinearCurrentIssueContext>()),
  resolveLegacyLinearLinkWorkspace: () => ({ workspaceId: 'ws-1', organizationUrlKey: 'acme' })
}))

import { materializeWorktreePushTargetRemote } from '../../../ipc/worktree-remote'

import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'

const MOVING_WT = 'repo-1::/ws/repo-1/wt'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-incidental-'))
  loadWslMoveFence(userDataPath)
  seedWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
  gitExecFileAsyncMock.mockReset()
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'remote' && args[1] === 'get-url') {
      throw new Error('No such remote')
    }
    return { stdout: '', stderr: '' }
  })
})
afterEach(() => {
  resetWslMoveFenceForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('push-target bookkeeping under a WSL move', () => {
  const target: GitPushTarget = {
    remoteName: 'pr-contributor-orca',
    branchName: 'contributor/fix',
    remoteUrl: 'git@github.com:contributor/orca.git'
  }

  async function push(worktreeId: string, hostId?: ExecutionHostId) {
    const setWorktreeMeta = vi.fn()
    const meta = hostId ? { [worktreeId]: mergeWorktreeMetaForWrite(undefined, { hostId }) } : {}
    const repos = [
      { id: 'repo-1', path: '/ws/repo-1', displayName: 'r', badgeColor: '#000', addedAt: 0 },
      {
        id: 'repo-1',
        path: '/ws/repo-1',
        displayName: 'r',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: 'target-1'
      },
      { id: 'repo-2', path: '/ws/repo-2', displayName: 'r', badgeColor: '#000', addedAt: 0 }
    ]
    const store = { getAllWorktreeMeta: () => meta, getRepos: () => repos, setWorktreeMeta }
    const result = await materializeWorktreePushTargetRemote(
      '/ws/repo',
      target,
      store,
      undefined,
      {},
      hostWorktreeTarget({ id: worktreeId, hostId: hostId ?? 'local' })
    )
    return { result, setWorktreeMeta }
  }

  it('still pushes the moving worktree but skips its metadata write', async () => {
    const { result, setWorktreeMeta } = await push(MOVING_WT)
    expect(result).toEqual({ ...target, remoteCreated: true })
    expect(setWorktreeMeta).not.toHaveBeenCalled()
  })
})
