import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../../dispatcher'
import type { RpcRequest } from '../../../core'
import '../../../../orca-runtime'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

import { GITLAB_METHODS } from './gitlab'
import '../../../../../../shared/rpc-contract/source-control/gitlab-params'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('gitlab RPC methods', () => {
  it('accepts the negotiated approval update field', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateGitLabRepoMR: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITLAB_METHODS })
    const response = await dispatcher.dispatch(
      makeRequest('gitlab.updateMR', {
        repo: 'id:repo-1',
        iid: 8,
        updates: { approval: 'approve' }
      })
    )
    expect(runtime.updateGitLabRepoMR).toHaveBeenCalledWith(
      'id:repo-1',
      8,
      { approval: 'approve' },
      undefined
    )
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })

  it('rejects an unknown approval update value', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateGitLabRepoMR: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: GITLAB_METHODS })
    const response = await dispatcher.dispatch(
      makeRequest('gitlab.updateMR', {
        repo: 'id:repo-1',
        iid: 8,
        updates: { approval: 'bogus' }
      })
    )
    expect(runtime.updateGitLabRepoMR).not.toHaveBeenCalled()
    expect(response).toMatchObject({ ok: false })
  })
})
