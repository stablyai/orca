import { describe, expect, it, beforeEach } from 'vitest'
import { SshGitProvider } from './ssh-git-provider'
import { createMockMux, type MockMultiplexer } from './ssh-git-provider-test-harness'
import { GIT_STAGE_WORKTREE_SCOPE_UNSUPPORTED_MESSAGE } from '../../shared/git-stage-worktree-scope'

describe('SshGitProvider', () => {
  let mux: MockMultiplexer
  let provider: SshGitProvider

  beforeEach(() => {
    mux = createMockMux()
    provider = new SshGitProvider('conn-1', mux as never)
  })

  it('commit sends git.commit request', async () => {
    const commitResult = { success: true }
    mux.request.mockResolvedValue(commitResult)

    const result = await provider.commit('/home/user/repo', 'feat: add source control commit')

    expect(mux.request).toHaveBeenCalledWith('git.commit', {
      worktreePath: '/home/user/repo',
      message: 'feat: add source control commit'
    })
    expect(result).toEqual(commitResult)
  })

  it('stageFile sends git.stage request', async () => {
    await provider.stageFile('/home/user/repo', 'src/file.ts')
    expect(mux.request).toHaveBeenCalledWith('git.stage', {
      worktreePath: '/home/user/repo',
      filePath: 'src/file.ts'
    })
  })

  it('unstageFile sends git.unstage request', async () => {
    await provider.unstageFile('/home/user/repo', 'src/file.ts')
    expect(mux.request).toHaveBeenCalledWith('git.unstage', {
      worktreePath: '/home/user/repo',
      filePath: 'src/file.ts'
    })
  })

  it('bulkStageFiles sends git.bulkStage request', async () => {
    await provider.bulkStageFiles('/home/user/repo', ['a.ts', 'b.ts'])
    expect(mux.request).toHaveBeenCalledWith('git.bulkStage', {
      worktreePath: '/home/user/repo',
      filePaths: ['a.ts', 'b.ts']
    })
  })

  it('bulkStageFiles forwards a whole-worktree scope and accepts the relay receipt', async () => {
    mux.request.mockResolvedValue({ stagedScope: 'all' })
    await provider.bulkStageFiles('/home/user/repo', [], 'all')
    expect(mux.request).toHaveBeenCalledWith('git.bulkStage', {
      worktreePath: '/home/user/repo',
      filePaths: [],
      scope: 'all'
    })
  })

  it('bulkStageFiles rejects a scoped stage an older relay answered without a receipt', async () => {
    // An older relay strips `scope`, stages the empty path list, and replies with nothing.
    mux.request.mockResolvedValue(undefined)
    await expect(provider.bulkStageFiles('/home/user/repo', [], 'all')).rejects.toThrow(
      GIT_STAGE_WORKTREE_SCOPE_UNSUPPORTED_MESSAGE
    )
    mux.request.mockResolvedValue({ stagedScope: 'tracked' })
    await expect(provider.bulkStageFiles('/home/user/repo', [], 'all')).rejects.toThrow(
      GIT_STAGE_WORKTREE_SCOPE_UNSUPPORTED_MESSAGE
    )
  })

  it('bulkUnstageFiles sends git.bulkUnstage request', async () => {
    await provider.bulkUnstageFiles('/home/user/repo', ['a.ts', 'b.ts'])
    expect(mux.request).toHaveBeenCalledWith('git.bulkUnstage', {
      worktreePath: '/home/user/repo',
      filePaths: ['a.ts', 'b.ts']
    })
  })

  it('discardChanges sends git.discard request', async () => {
    await provider.discardChanges('/home/user/repo', 'src/file.ts')
    expect(mux.request).toHaveBeenCalledWith('git.discard', {
      worktreePath: '/home/user/repo',
      filePath: 'src/file.ts'
    })
  })

  it('bulkDiscardChanges sends git.bulkDiscard request', async () => {
    await provider.bulkDiscardChanges('/home/user/repo', ['a.ts', 'b.ts'])
    expect(mux.request).toHaveBeenCalledWith('git.bulkDiscard', {
      worktreePath: '/home/user/repo',
      filePaths: ['a.ts', 'b.ts']
    })
  })
})
