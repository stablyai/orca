import { describe, expect, it } from 'vitest'
import { handleMockRepoProjectRequest } from './mock-server-repo-project'
import type { RpcRequest, RpcResponse } from './mock-server-rpc-handlers'

describe('mock repo project RPCs', () => {
  it('returns an invalid_params reply for a clone URL without a repository name', () => {
    const replies: RpcResponse[] = []
    const request: RpcRequest = {
      id: 'clone-invalid',
      method: 'repo.clone',
      params: { url: 'https://example.com/..' }
    }

    expect(
      handleMockRepoProjectRequest(
        request,
        (response) => replies.push(response),
        (id, result) => ({ id, ok: true, result, _meta: { runtimeId: 'test' } }),
        (id, code, message) => ({
          id,
          ok: false,
          error: { code, message },
          _meta: { runtimeId: 'test' }
        })
      )
    ).toBe(true)
    expect(replies).toEqual([
      {
        id: 'clone-invalid',
        ok: false,
        error: { code: 'invalid_params', message: expect.any(String) },
        _meta: { runtimeId: 'test' }
      }
    ])
  })
})
