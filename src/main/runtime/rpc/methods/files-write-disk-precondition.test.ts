import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { FILE_METHODS } from './files'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('files.writeIfUnchanged', () => {
  it('forwards a save disk precondition to the runtime writer', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reaches only the two stubbed members.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      writeFileExplorerFile: vi.fn().mockResolvedValue({ ok: false, diskConflict: 'changed' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
    const diskPrecondition = {
      expectedSignature: 'a-b-1',
      allowMissing: true,
      requireLosslessUtf8: true
    }

    const response = await dispatcher.dispatch(
      makeRequest('files.writeIfUnchanged', {
        worktree: 'id:wt-1',
        relativePath: 'src/index.ts',
        content: 'export {}',
        expectedExecutionHostId: 'local',
        diskPrecondition
      })
    )

    expect(runtime.writeFileExplorerFile).toHaveBeenCalledWith(
      'id:wt-1',
      'src/index.ts',
      'export {}',
      undefined,
      undefined,
      'local',
      diskPrecondition
    )
    expect(response).toMatchObject({ ok: true, result: { ok: false, diskConflict: 'changed' } })
  })

  it('strips an unknown write field the way an older host would', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reaches only the two stubbed members.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      writeFileExplorerFile: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })

    await dispatcher.dispatch(
      makeRequest('files.write', {
        worktree: 'id:wt-1',
        relativePath: 'src/index.ts',
        content: 'export {}',
        futureField: true
      })
    )

    expect(runtime.writeFileExplorerFile).toHaveBeenCalledWith(
      'id:wt-1',
      'src/index.ts',
      'export {}'
    )
  })
})
