import { describe, expect, it, beforeEach } from 'vitest'
import {
  createSshDisposalError,
  SSH_MUX_REQUEST_TIMEOUT_CODE
} from '../ssh/ssh-channel-multiplexer'
import { SshGitProvider } from './ssh-git-provider'
import { createMockMux, type MockMultiplexer } from './ssh-git-provider-test-harness'

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

  describe('carryWorkingTreeChanges', () => {
    it('sends git.carryWorkingTreeChanges with a 120s timeout and normalizes the reply', async () => {
      mux.request.mockResolvedValue({ ok: true, trackedChanges: true, untrackedCopied: 2 })

      const result = await provider.carryWorkingTreeChanges('/home/user/repo', '/home/user/child')

      expect(mux.request).toHaveBeenCalledWith(
        'git.carryWorkingTreeChanges',
        { sourceWorktreePath: '/home/user/repo', targetWorktreePath: '/home/user/child' },
        { timeoutMs: 120_000 }
      )
      expect(result).toEqual({ ok: true, trackedChanges: true, untrackedCopied: 2 })
    })

    it('reports a possibly-applied carry after a request timeout', async () => {
      const timeoutError = Object.assign(
        new Error('Request "git.carryWorkingTreeChanges" timed out'),
        {
          code: SSH_MUX_REQUEST_TIMEOUT_CODE
        }
      )
      mux.request.mockRejectedValue(timeoutError)

      const result = await provider.carryWorkingTreeChanges('/home/user/repo', '/home/user/child')

      expect(result).toEqual({
        ok: false,
        reason: 'partially_applied',
        detail: timeoutError.message
      })
    })

    it('reports a possibly-applied carry after the connection is lost', async () => {
      const lostError = createSshDisposalError('connection_lost')
      mux.request.mockRejectedValue(lostError)

      const result = await provider.carryWorkingTreeChanges('/home/user/repo', '/home/user/child')

      expect(result).toEqual({
        ok: false,
        reason: 'partially_applied',
        detail: lostError.message
      })
    })

    it('rethrows a verifiable error unchanged', async () => {
      const ordinaryError = new Error('boom')
      mux.request.mockRejectedValue(ordinaryError)

      await expect(
        provider.carryWorkingTreeChanges('/home/user/repo', '/home/user/child')
      ).rejects.toThrow('boom')
    })
  })
})
