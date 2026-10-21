import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
  updateForward: vi.fn(),
  persist: vi.fn(),
  broadcast: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      h.handlers.set(channel, handler)
  }
}))
vi.mock('./ssh-ipc-context', () => ({
  connectionManager: { getConnection: () => ({}) },
  getCurrentMainWindow: () => null,
  persistedStore: null,
  portForwardManager: { updateForward: h.updateForward }
}))
vi.mock('./ssh-port-forward-persistence', () => ({ persistPortForwards: h.persist }))
vi.mock('./ssh-renderer-broadcast', () => ({
  broadcastPortForwards: h.broadcast,
  enrichDetected: vi.fn()
}))

const { registerSshPortForwardHandlers } = await import('./ssh-port-forward-handlers')
const { PortForwardTornDownError } = await import('../../ssh/port-forwarding/ssh-port-forward')

const edit = {
  id: 'pf-1',
  targetId: 't1',
  localPort: 3001,
  remoteHost: '127.0.0.1',
  remotePort: 80
}

describe('ssh:updatePortForward', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.handlers.clear()
    registerSshPortForwardHandlers()
  })

  it("keeps the target's saved forwards when a Disconnect cancels the edit", async () => {
    h.updateForward.mockRejectedValue(new PortForwardTornDownError())
    await expect(h.handlers.get('ssh:updatePortForward')!({}, edit)).rejects.toThrow(
      PortForwardTornDownError
    )
    expect(h.persist).not.toHaveBeenCalled()
    // The renderer still drops the row the edit closed.
    expect(h.broadcast).toHaveBeenCalled()
  })

  it('resyncs saved forwards after an ordinary failed edit', async () => {
    h.updateForward.mockRejectedValue(new Error('port in use'))
    await expect(h.handlers.get('ssh:updatePortForward')!({}, edit)).rejects.toThrow('port in use')
    expect(h.persist).toHaveBeenCalledWith('t1')
  })
})
