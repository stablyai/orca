import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../dispatcher'
import type { RpcRequest } from '../../core'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { BROWSER_EXTRA_METHODS } from './browser-extras'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('browser.cookie.import RPC', () => {
  it('dispatches a file import to runtime.browserCookieImport', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      browserCookieImport: vi.fn().mockResolvedValue({ ok: true, profileId: 'profile-1' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: BROWSER_EXTRA_METHODS })

    await dispatcher.dispatch(
      makeRequest('browser.cookie.import', {
        file: '/tmp/cookies.json',
        profileId: 'profile-1'
      })
    )

    expect(runtime.browserCookieImport).toHaveBeenCalledWith({
      file: '/tmp/cookies.json',
      profileId: 'profile-1'
    })
  })
})
