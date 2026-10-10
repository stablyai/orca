import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { FILE_METHODS } from './files'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('file RPC SSH browse methods', () => {
  it('passes the SSH target to remote server directory browse', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      browseServerDir: vi.fn().mockResolvedValue({ resolvedPath: '/srv', entries: [] })
    } satisfies Pick<OrcaRuntimeService, 'getRuntimeId' | 'browseServerDir'>
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture is structurally complete for the selected RPC method; dispatch only reads getRuntimeId and browseServerDir.
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: FILE_METHODS
    })

    await dispatcher.dispatch(
      makeRequest('files.browseServerDir', { path: '/srv', sshConnectionId: 'ssh-vm' })
    )

    expect(runtime.browseServerDir).toHaveBeenCalledWith('/srv', 'ssh-vm')
  })
})
