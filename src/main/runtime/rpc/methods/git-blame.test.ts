import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { GIT_METHODS } from './git'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('git.blame RPC method', () => {
  it('returns blame lines for a selected file', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getRuntimeGitBlame: vi.fn().mockResolvedValue({
        status: 'ready',
        lines: [
          {
            line: 1,
            commitOid: 'a'.repeat(40),
            author: 'Ada',
            authorTime: 1,
            summary: 'Add'
          }
        ]
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('git.blame', { worktree: 'id:wt-1', filePath: 'src/index.ts' })
    )

    expect(runtime.getRuntimeGitBlame).toHaveBeenCalledWith(
      'id:wt-1',
      'src/index.ts',
      undefined,
      undefined
    )
    expect(response).toMatchObject({
      ok: true,
      result: { status: 'ready', lines: [expect.objectContaining({ author: 'Ada' })] }
    })
  })

  it('forwards an optional blame revision', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getRuntimeGitBlame: vi.fn().mockResolvedValue({ status: 'ready', lines: [] })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })
    const commitId = 'a'.repeat(40)

    await dispatcher.dispatch(
      makeRequest('git.blame', {
        worktree: 'id:wt-1',
        filePath: 'src/index.ts',
        revision: commitId
      })
    )

    expect(runtime.getRuntimeGitBlame).toHaveBeenCalledWith(
      'id:wt-1',
      'src/index.ts',
      commitId,
      undefined
    )
  })

  it('rejects a flag-like blame revision before the runtime runs git', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getRuntimeGitBlame: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('git.blame', {
        worktree: 'id:wt-1',
        filePath: 'src/index.ts',
        revision: '--output=/tmp/pwned'
      })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.getRuntimeGitBlame).not.toHaveBeenCalled()
  })

  it('forwards index blame contents', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getRuntimeGitBlame: vi.fn().mockResolvedValue({ status: 'ready', lines: [] })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })

    await dispatcher.dispatch(
      makeRequest('git.blame', {
        worktree: 'id:wt-1',
        filePath: 'src/index.ts',
        revision: 'HEAD',
        contentsSource: 'index'
      })
    )

    expect(runtime.getRuntimeGitBlame).toHaveBeenCalledWith(
      'id:wt-1',
      'src/index.ts',
      'HEAD',
      'index'
    )
  })
})
