import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitHubClient from '../github/client'

const getPRForBranchMock = vi.hoisted(() => vi.fn())

vi.mock('../github/client', async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubClient>()),
  getPRForBranch: getPRForBranchMock
}))

import { getLocalGitHubPrForBranch } from './runtime-worktree-create-git'

beforeEach(() => {
  getPRForBranchMock.mockReset()
  getPRForBranchMock.mockResolvedValue(null)
})

describe('getLocalGitHubPrForBranch', () => {
  it('routes the PR lookup through the WSL distro', async () => {
    await getLocalGitHubPrForBranch('/repo', 'app', { wslDistro: 'Ubuntu' })

    expect(getPRForBranchMock).toHaveBeenCalledWith('/repo', 'app', null, null, null, {
      localGitExecOptions: { wslDistro: 'Ubuntu' }
    })
  })

  it('uses the plain lookup without project git options', async () => {
    await getLocalGitHubPrForBranch('/repo', 'app', {})

    expect(getPRForBranchMock).toHaveBeenCalledWith('/repo', 'app')
  })
})
