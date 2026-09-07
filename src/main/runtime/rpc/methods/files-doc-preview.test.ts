import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { FILE_METHODS } from './files'

describe('files.readDocPreview', () => {
  it('passes document-preview authority to the dedicated host method', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      readDocPreviewFile: vi.fn().mockResolvedValue({
        content: '<h1>safe</h1>',
        isBinary: false
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
    const request: RpcRequest = {
      id: 'req-1',
      authToken: 'tok',
      method: 'files.readDocPreview',
      params: {
        worktree: 'id:wt-1',
        relativePath: 'docs/index.html',
        entryRelativePath: 'docs/index.html',
        implicitRootRelativePath: 'docs',
        authorizedRootRelativePaths: ['assets']
      }
    }

    const response = await dispatcher.dispatch(request)

    expect(runtime.readDocPreviewFile).toHaveBeenCalledWith(
      'id:wt-1',
      'docs/index.html',
      'docs/index.html',
      'docs',
      ['assets'],
      undefined
    )
    expect(response).toMatchObject({ ok: true, result: { content: '<h1>safe</h1>' } })
  })
})
