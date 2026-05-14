import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { FILE_METHODS } from './files'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('file RPC methods', () => {
  it('lists files for a selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listMobileFiles: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        rootPath: '/repo',
        files: [],
        totalCount: 0,
        truncated: false
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(makeRequest('files.list', { worktree: 'id:wt-1' }))

    expect(runtime.listMobileFiles).toHaveBeenCalledWith('id:wt-1')
    expect(response).toMatchObject({
      ok: true,
      result: { worktree: 'wt-1', files: [] }
    })
  })

  it('opens a relative file path for a selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      openMobileFile: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        relativePath: 'docs/readme.md',
        kind: 'markdown',
        opened: true
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.open', { worktree: 'id:wt-1', relativePath: 'docs/readme.md' })
    )

    expect(runtime.openMobileFile).toHaveBeenCalledWith('id:wt-1', 'docs/readme.md')
    expect(response).toMatchObject({
      ok: true,
      result: { kind: 'markdown', opened: true }
    })
  })

  it('reads a relative file path for a selected worktree', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      readMobileFile: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        relativePath: 'src/index.ts',
        content: 'export {}\\n',
        truncated: false,
        byteLength: 10
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.read', { worktree: 'id:wt-1', relativePath: 'src/index.ts' })
    )

    expect(runtime.readMobileFile).toHaveBeenCalledWith('id:wt-1', 'src/index.ts')
    expect(response).toMatchObject({
      ok: true,
      result: { content: 'export {}\\n', truncated: false }
    })
  })
})
