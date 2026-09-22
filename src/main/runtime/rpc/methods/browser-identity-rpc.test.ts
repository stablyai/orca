import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  get: vi.fn(() => ({ identity: { state: 'missing' }, migrationNotice: null })),
  set: vi.fn(async () => ({ ok: true }))
}))

vi.mock('../../../browser/browser-identity-mode-store', () => ({
  getBrowserIdentityModeStatus: mocks.get,
  setBrowserIdentityMode: mocks.set
}))

import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { BROWSER_IDENTITY_METHODS } from './browser-identity-rpc'

function request(method: string, params?: unknown): RpcRequest {
  return { id: 'identity-1', authToken: 'token', method, params }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the identity handlers read no runtime member; only the reply envelope needs getRuntimeId.
const RUNTIME = { getRuntimeId: () => 'runtime-1' } as unknown as OrcaRuntimeService

function identityDispatcher(): RpcDispatcher {
  return new RpcDispatcher({ runtime: RUNTIME, methods: BROWSER_IDENTITY_METHODS })
}

describe('browser identity RPC', () => {
  it('serves the host-local identity snapshot', async () => {
    const response = await identityDispatcher().dispatch(request('browser.identity.get'))

    expect(response).toMatchObject({ ok: true, result: { migrationNotice: null } })
    expect(mocks.get).toHaveBeenCalledTimes(1)
  })

  it('commits a host-local identity selection', async () => {
    await identityDispatcher().dispatch(request('browser.identity.set', { mode: 'native' }))

    expect(mocks.set).toHaveBeenCalledWith('native', { reset: undefined })
  })

  it('forwards an explicit reset request to the single writer', async () => {
    await identityDispatcher().dispatch(
      request('browser.identity.set', { mode: 'clean', reset: true })
    )

    expect(mocks.set).toHaveBeenCalledWith('clean', { reset: true })
  })
})
