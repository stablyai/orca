import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { FILE_METHODS } from './files'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('files.createFile owner routing', () => {
  it('preserves a runtime owner assertion through the RPC layer', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createFileExplorerFile: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('files.createFile', {
        worktree: 'id:wt-1',
        relativePath: 'unsafe.md',
        expectedExecutionHostId: 'runtime:environment-2'
      })
    )

    expect(runtime.createFileExplorerFile).toHaveBeenCalledWith(
      'id:wt-1',
      'unsafe.md',
      undefined,
      undefined,
      'runtime:environment-2'
    )
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })
})
