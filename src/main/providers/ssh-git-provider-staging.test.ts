import { describe, expect, it, beforeEach } from 'vitest'
import { JsonRpcErrorCode } from '../ssh/relay-protocol'
import { SshGitProvider } from './ssh-git-provider'
import {
  createMockMux,
  waitForRequestCount,
  type MockMultiplexer
} from './ssh-git-provider-test-harness'

function methodNotFoundError(): Error & { code: number } {
  return Object.assign(new Error('Method not found: git.bulkStage'), {
    code: JsonRpcErrorCode.MethodNotFound
  })
}

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

  it('falls back sequentially on an old relay and caches that connection capability', async () => {
    mux.request.mockImplementation(async (method: string) => {
      if (method === 'git.bulkStage') {
        throw methodNotFoundError()
      }
    })

    await provider.bulkStageFiles('/home/user/repo', ['a.ts', 'b.ts'])
    await provider.bulkStageFiles('/home/user/repo', ['c.ts'])

    expect(mux.request.mock.calls).toEqual([
      ['git.bulkStage', { worktreePath: '/home/user/repo', filePaths: ['a.ts', 'b.ts'] }],
      ['git.stage', { worktreePath: '/home/user/repo', filePath: 'a.ts' }],
      ['git.stage', { worktreePath: '/home/user/repo', filePath: 'b.ts' }],
      ['git.stage', { worktreePath: '/home/user/repo', filePath: 'c.ts' }]
    ])
  })

  it('does not fall back after a generic bulk-stage failure', async () => {
    const failure = Object.assign(new Error('relay failed'), { code: -32_000 })
    mux.request.mockRejectedValue(failure)

    await expect(provider.bulkStageFiles('/home/user/repo', ['a.ts', 'b.ts'])).rejects.toBe(failure)

    expect(mux.request).toHaveBeenCalledTimes(1)
    expect(mux.request).toHaveBeenCalledWith('git.bulkStage', {
      worktreePath: '/home/user/repo',
      filePaths: ['a.ts', 'b.ts']
    })
  })

  it('re-probes bulk staging after the SSH provider is replaced', async () => {
    mux.request.mockRejectedValueOnce(methodNotFoundError())
    await provider.bulkStageFiles('/home/user/repo', ['a.ts'])

    mux.request.mockReset().mockResolvedValue(undefined)
    provider = new SshGitProvider('conn-2', mux as never)
    await provider.bulkStageFiles('/home/user/repo', ['b.ts'])

    expect(mux.request).toHaveBeenCalledTimes(1)
    expect(mux.request).toHaveBeenCalledWith('git.bulkStage', {
      worktreePath: '/home/user/repo',
      filePaths: ['b.ts']
    })
  })

  it('shares an old-relay capability probe across concurrent bulk-stage calls', async () => {
    let rejectBulk!: (error: Error) => void
    mux.request.mockImplementation((method: string) => {
      if (method !== 'git.bulkStage') {
        return Promise.resolve(undefined)
      }
      return new Promise((_, reject) => {
        rejectBulk = reject
      })
    })

    const first = provider.bulkStageFiles('/home/user/repo', ['a.ts'])
    const second = provider.bulkStageFiles('/home/user/repo', ['b.ts'])
    await waitForRequestCount(mux.request, 1)
    expect(mux.request).toHaveBeenCalledTimes(1)

    rejectBulk(methodNotFoundError())
    await Promise.all([first, second])
    expect(mux.request.mock.calls).toEqual([
      ['git.bulkStage', { worktreePath: '/home/user/repo', filePaths: ['a.ts'] }],
      ['git.stage', { worktreePath: '/home/user/repo', filePath: 'a.ts' }],
      ['git.stage', { worktreePath: '/home/user/repo', filePath: 'b.ts' }]
    ])
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
