import { beforeEach, describe, expect, it, vi } from 'vitest'

type LiveForward = {
  id: string
  connectionId: string
  localPort: number
  remoteHost: string
  remotePort: number
}

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
  updateForward: vi.fn(),
  addForward: vi.fn(),
  previous: {
    id: 'pf-1',
    connectionId: 't1',
    localPort: 3000,
    remoteHost: '127.0.0.1',
    remotePort: 80
  },
  live: new Array<LiveForward>(),
  removeForwardAndWait: vi.fn(async () => null),
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
  portForwardManager: {
    updateForward: h.updateForward,
    addForward: h.addForward,
    listForwards: () => h.live,
    removeForwardAndWait: h.removeForwardAndWait
  }
}))
vi.mock('./ssh-port-forward-persistence', () => ({ persistPortForwards: h.persist }))
vi.mock('./ssh-renderer-broadcast', () => ({
  broadcastPortForwards: h.broadcast,
  enrichDetected: vi.fn()
}))

const { registerSshPortForwardHandlers } = await import('./ssh-port-forward-handlers')
const { PortForwardTornDownError } = await import('../../ssh/port-forwarding/ssh-port-forward')
const { isForwardBackingOff, recordForwardFailure } = await import('./ssh-port-forward-unrestored')

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
    h.live = [h.previous]
    h.handlers.clear()
    registerSshPortForwardHandlers()
  })

  it("keeps the target's saved forwards when a Disconnect cancels the edit", async () => {
    h.updateForward.mockRejectedValue(new PortForwardTornDownError())
    await expect(h.handlers.get('ssh:updatePortForward')!({}, edit)).rejects.toThrow(
      PortForwardTornDownError
    )
    expect(h.persist).not.toHaveBeenCalled()
    expect(h.broadcast).toHaveBeenCalled()
  })

  it('resyncs saved forwards after an ordinary failed edit', async () => {
    h.updateForward.mockRejectedValue(new Error('port in use'))
    await expect(h.handlers.get('ssh:updatePortForward')!({}, edit)).rejects.toThrow('port in use')
    expect(h.persist).toHaveBeenCalledWith('t1')
  })

  it('closes a forward a restore opened before a queued saved-forward remove ran', async () => {
    h.live = [{ ...h.previous, localPort: 4100 }]
    await h.handlers.get('ssh:removeSavedPortForward')!(
      {},
      { targetId: 't1', localPort: 4100, remoteHost: '127.0.0.1', remotePort: 80 }
    )
    expect(h.removeForwardAndWait).toHaveBeenCalledWith('pf-1')
  })

  it('starts a re-added forward on a fresh backoff', async () => {
    const mapping = { localPort: 4100, remoteHost: '127.0.0.1', remotePort: 80 }
    recordForwardFailure('t1', mapping, new Error('port in use'))
    h.addForward.mockResolvedValue({ id: 'pf-3', connectionId: 't1', ...mapping })
    await h.handlers.get('ssh:addPortForward')!({}, { targetId: 't1', ...mapping })
    expect(isForwardBackingOff('t1', mapping)).toBe(false)
  })

  it('drops only the edited-away forward from the saved list', async () => {
    h.updateForward.mockResolvedValue({ ...h.previous, localPort: 3001 })
    await h.handlers.get('ssh:updatePortForward')!({}, edit)
    expect(h.persist).toHaveBeenCalledWith('t1', h.previous)
  })

  it('skips a remove whose forward an edit queued ahead of it replaced', async () => {
    let finishEdit: (() => void) | null = null
    h.updateForward.mockImplementation(async () => {
      await new Promise<void>((resolve) => (finishEdit = resolve))
      h.live = [{ ...h.previous, id: 'pf-2' }]
      return h.live[0]
    })
    const editing = h.handlers.get('ssh:updatePortForward')!({}, edit)
    await vi.waitFor(() => expect(finishEdit).not.toBeNull())
    const removing = h.handlers.get('ssh:removePortForward')!({}, { id: 'pf-1' })
    finishEdit!()
    await editing
    await expect(removing).resolves.toBeNull()
    expect(h.removeForwardAndWait).not.toHaveBeenCalled()
  })
})
