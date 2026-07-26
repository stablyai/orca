import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { FILE_METHODS } from './files'

describe('file path search RPC method', () => {
  it('returns a bounded server-side result for mobile autocomplete', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      searchMobileFilePaths: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        rootPath: '/repo',
        files: [{ relativePath: 'src/app.ts', basename: 'app.ts', kind: 'text' }],
        totalCount: 1,
        truncated: false
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
    const request: RpcRequest = {
      id: 'req-1',
      authToken: 'tok',
      method: 'files.searchPaths',
      params: { worktree: 'id:wt-1', query: 'app', limit: 8 }
    }

    const response = await dispatcher.dispatch(request)

    expect(runtime.searchMobileFilePaths).toHaveBeenCalledWith('id:wt-1', 'app', 8)
    expect(response).toMatchObject({
      ok: true,
      result: { files: [{ relativePath: 'src/app.ts' }] }
    })
  })
})
