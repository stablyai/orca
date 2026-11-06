import { beforeEach, describe, expect, it, vi } from 'vitest'

const { reconcile, send, target } = vi.hoisted(() => {
  const target: { current: unknown } = { current: undefined }
  return { reconcile: vi.fn(), send: vi.fn(), target }
})

vi.mock('../browser/desktop-browser-bridge-reconcile', () => ({
  requestDesktopBrowserBridgeReconcile: reconcile
}))
vi.mock('../../ssh/targets/ssh-target-registry', () => ({
  getSshTargetRegistryStore: () => ({ getTarget: () => target.current })
}))
vi.mock('./ssh-ipc-context', () => ({
  connectionManager: null,
  currentRuntime: null,
  getCurrentMainWindow: () => null,
  persistedStore: null,
  portForwardManager: null
}))
vi.mock('../../ssh/ssh-provider-authority', () => ({
  getSshProviderAuthority: () => ({ providerEpoch: 'epoch', connectionGeneration: 1 })
}))
vi.mock('../../ssh/ssh-host-server-status', () => ({
  clearSshHostServerStatus: vi.fn(),
  getSshHostServerStatus: () => undefined
}))

import { broadcastSshState } from './ssh-renderer-broadcast'

const window = { isDestroyed: () => false, webContents: { send } }
const connected = { targetId: '', status: 'connected', error: null, reconnectAttempt: 0 } as const

describe('SSH state broadcast', () => {
  beforeEach(() => {
    reconcile.mockClear()
    send.mockClear()
  })

  it('rechecks the desktop browser bridge when an environment recipe host connects', () => {
    target.current = {
      id: 'runtime-ssh-vm-1',
      owner: { type: 'on-demand-runtime', runtimeId: 'vm-1' }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: broadcast reads only these window members.
    broadcastSshState(() => window as never, 'runtime-ssh-vm-1', connected)

    expect(send).not.toHaveBeenCalled()
    expect(reconcile).toHaveBeenCalledTimes(1)
  })
})
