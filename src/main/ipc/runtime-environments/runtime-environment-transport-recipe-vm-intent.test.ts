// #36923: the desktop's own calls and subscriptions tell the server preparation which request
// needs the server (only one that opens a workspace may wake a sleeping recipe VM) and hand it
// their abort signal, so a caller that gives up stops waiting on a wake.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveManaged: vi.fn(
    async (
      _userDataPath: string,
      id: string,
      _preparation?: unknown,
      _method?: string,
      _signal?: AbortSignal
    ) => ({ id, pairingRevision: 1 })
  ),
  // The server comes back re-paired, so the caller's pairing fence ends the call right after
  // its preparation: only what preparation was handed is under test.
  prepareRequest: vi.fn(
    async (
      _userDataPath: string,
      id: string,
      _preparation?: unknown,
      _method?: string,
      _signal?: AbortSignal
    ) => ({
      environment: { id, pairingRevision: 2, createdAt: 0 },
      before: { id, pairingRevision: 2, createdAt: 0 },
      wokenPairingRevision: null
    })
  )
}))

vi.mock('electron', () => ({ app: { getPath: () => '/user-data' } }))
vi.mock('../../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  resolveEnvironment: (_userDataPath: string, id: string) => ({ id, pairingRevision: 1 }),
  markEnvironmentUsed: vi.fn()
}))
vi.mock('../../../shared/remote-runtime/host-catalog/runtime-environments', () => ({
  getPreferredPairedRuntimeConnection: () => ({ endpoint: 'ws://vm:6768' })
}))
vi.mock('./runtime-environment-managed-tunnel', () => ({
  resolveManagedRuntimeEnvironment: mocks.resolveManaged,
  prepareManagedRuntimeRequest: mocks.prepareRequest,
  requireWslHostWithoutStart: vi.fn()
}))
vi.mock('../../../shared/remote-runtime/remote-runtime-client', () => ({
  subscribeRemoteRuntimeRequest: vi.fn(async () => ({ close: vi.fn() }))
}))
vi.mock('./runtime-environment-support-routing', () => ({
  shouldRouteSubscriptionBySupport: () => false
}))

import {
  callRuntimeEnvironment,
  subscribeRuntimeEnvironment
} from './runtime-environment-transport-routing'

const callbacks = { onEvent: vi.fn(), onClose: vi.fn() }

describe('runtime environment transport and a sleeping recipe VM', () => {
  beforeEach(() => {
    mocks.resolveManaged.mockClear()
    mocks.prepareRequest.mockClear()
  })

  it.each(['worktree.activate', 'worktree.ps'])(
    'prepares the server for a %s call with its method and signal',
    async (method) => {
      const signal = new AbortController().signal
      const response = await callRuntimeEnvironment(
        '/user-data',
        'env-vm',
        method,
        {},
        1000,
        1,
        undefined,
        { preparation: { wslStart: 'never' }, signal }
      )
      expect(response).toMatchObject({ ok: false, error: { code: 'runtime_environment_changed' } })
      expect(mocks.prepareRequest).toHaveBeenCalledWith(
        '/user-data',
        'env-vm',
        { wslStart: 'never' },
        method,
        signal
      )
    }
  )

  it('prepares the server for a subscription with its method and signal', async () => {
    const signal = new AbortController().signal
    await subscribeRuntimeEnvironment(
      '/user-data',
      'env-vm',
      'runtime.clientEvents.subscribe',
      undefined,
      1000,
      callbacks,
      () => true,
      signal
    )
    expect(mocks.resolveManaged).toHaveBeenCalledWith(
      '/user-data',
      'env-vm',
      undefined,
      'runtime.clientEvents.subscribe',
      signal
    )
  })
})
