import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('./ssh-active-relay-sessions', () => ({ activeSessions: new Map() }))

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  blocked: new Set<string>(),
  connection: {},
  forwards: [
    { id: 'pf-1', connectionId: 'host', localPort: 8080, remoteHost: 'localhost', remotePort: 80 }
  ],
  saved: [{ localPort: 8080, remoteHost: 'localhost', remotePort: 80 }],
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  persist: vi.fn(),
  broadcast: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => state.handlers.set(name, fn)
  }
}))
vi.mock('./ssh-reset-production-state', () => ({
  assertSshResetAdmissionAllowed: (targetId: string) => {
    if (state.blocked.has(targetId)) {
      throw new Error('ssh_reset_operation_reconciliation_required')
    }
  }
}))
vi.mock('./ssh-ipc-context', () => ({
  connectionManager: { getConnection: () => state.connection },
  portForwardManager: {
    listForwards: () => state.forwards,
    addForward: state.add,
    updateForward: state.update,
    removeForwardAndWait: state.remove
  },
  persistedStore: null,
  getCurrentMainWindow: () => null
}))
vi.mock('../ssh/ssh-target-registry', () => ({
  getSshTargetRegistryStore: () => ({
    getTarget: () => ({ portForwards: state.saved }),
    updateTarget: state.persist
  })
}))
vi.mock('../ports/ssh-advertised-url-enrichment', () => ({
  enrichSshForwardEntries: vi.fn(),
  getWorktreeIdsForConnection: vi.fn()
}))
vi.mock('./ssh-renderer-broadcast', () => ({
  broadcastPortForwards: state.broadcast,
  enrichDetected: vi.fn()
}))
import { registerSshPortForwardHandlers } from './ssh-port-forward-handlers'
import { restorePortForwards } from './ssh-port-forward-persistence'

const args = {
  id: 'pf-1',
  targetId: 'host',
  localPort: 8080,
  remoteHost: 'localhost',
  remotePort: 80
}
beforeEach(() => {
  vi.resetAllMocks()
  state.blocked.clear()
  state.saved = [{ localPort: 8080, remoteHost: 'localhost', remotePort: 80 }]
  state.add.mockResolvedValue(state.forwards[0])
  state.update.mockResolvedValue(state.forwards[0])
  state.remove.mockResolvedValue(state.forwards[0])
  registerSshPortForwardHandlers()
})

it.each(['add', 'update', 'remove'])('refuses %s while reset retains admission', async (action) => {
  state.blocked.add('host')
  await expect(state.handlers.get(`ssh:${action}PortForward`)!(null, args)).rejects.toThrow(
    'reconciliation_required'
  )
  expect(state.add).not.toHaveBeenCalled()
  expect(state.update).not.toHaveBeenCalled()
  expect(state.remove).not.toHaveBeenCalled()
  expect(state.persist).not.toHaveBeenCalled()
})

it('checks the actual owner even when update names another target', async () => {
  state.blocked.add('host')
  await expect(
    state.handlers.get('ssh:updatePortForward')!(null, { ...args, targetId: 'other' })
  ).rejects.toThrow('reconciliation_required')
  expect(state.update).not.toHaveBeenCalled()
})

it('rejects cross-target update before changing the forward', async () => {
  await expect(
    state.handlers.get('ssh:updatePortForward')!(null, { ...args, targetId: 'other' })
  ).rejects.toThrow('target mismatch')
  expect(state.update).not.toHaveBeenCalled()
  expect(state.persist).not.toHaveBeenCalled()
})

it.each(['add', 'update', 'remove'])(
  'does not persist %s completion after reset takes admission',
  async (action) => {
    state[action as 'add' | 'update' | 'remove'].mockImplementation(async () => {
      state.blocked.add('host')
      return state.forwards[0]
    })
    await expect(state.handlers.get(`ssh:${action}PortForward`)!(null, args)).rejects.toThrow(
      'reconciliation_required'
    )
    expect(state.persist).not.toHaveBeenCalled()
    expect(state.broadcast).not.toHaveBeenCalled()
  }
)

it('does not resync a failed update after reset takes admission', async () => {
  state.update.mockImplementation(async () => {
    state.blocked.add('host')
    throw new Error('update failed')
  })
  await expect(state.handlers.get('ssh:updatePortForward')!(null, args)).rejects.toThrow(
    'reconciliation_required'
  )
  expect(state.persist).not.toHaveBeenCalled()
})

it('leaves saved forwards untouched when restore is blocked', async () => {
  state.blocked.add('host')
  await restorePortForwards('host', () => null)
  expect(state.add).not.toHaveBeenCalled()
  expect(state.persist).not.toHaveBeenCalled()
})

it.each([1, 2])(
  'rechecks restore admission after awaiting a forward with %s saved entries',
  async (count) => {
    state.saved = Array.from({ length: count }, (_, i) => ({
      ...state.saved[0],
      localPort: 8080 + i
    }))
    state.add.mockImplementation(async () => {
      state.blocked.add('host')
    })
    await restorePortForwards('host', () => null)
    expect(state.add).toHaveBeenCalledTimes(1)
    expect(state.persist).not.toHaveBeenCalled()
    expect(state.broadcast).not.toHaveBeenCalled()
  }
)

it('preserves normal restoration and persistence', async () => {
  await restorePortForwards('host', () => null)
  expect(state.add).toHaveBeenCalledTimes(1)
  expect(state.persist).toHaveBeenCalledTimes(1)
  expect(state.broadcast).toHaveBeenCalledTimes(1)
})

it.each(['add', 'update', 'remove'])('preserves admitted %s completion', async (action) => {
  await expect(state.handlers.get(`ssh:${action}PortForward`)!(null, args)).resolves.toEqual(
    state.forwards[0]
  )
  expect(state.persist).toHaveBeenCalledTimes(1)
  expect(state.broadcast).toHaveBeenCalledTimes(1)
})
