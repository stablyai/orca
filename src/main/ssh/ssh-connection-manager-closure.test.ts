import {
  assertManagerTargetTransportsClosed,
  managerTargetActive,
  managerUnclosedTransportTargets
} from './ssh-connection-manager-test-probes'
import { beforeEach, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'

type ClosureMockState = {
  clients: { close: () => void; status: string }[]
  connectError?: Error
  disconnectError?: Error
}

const state = vi.hoisted((): ClosureMockState => ({ clients: [] }))
vi.mock('./ssh-connection', () => ({
  SshConnection: class {
    status = 'connected'
    close = () => {}
    constructor() {
      state.clients.push(this)
    }
    subscribeTransportClosure(callback: () => void) {
      this.close = callback
      return () => {}
    }
    async connect() {
      if (state.connectError) {
        throw state.connectError
      }
    }
    async disconnect() {
      if (state.disconnectError) {
        throw state.disconnectError
      }
      this.status = 'disconnected'
    }
    async disconnectAndDrain() {
      await this.disconnect()
      this.close()
    }
    getState() {
      return { status: this.status }
    }
    setCallbacks() {}
  }
}))
import { SshConnectionManager } from './ssh-connection-manager'

const target: SshTarget = {
  id: 'owned',
  label: 'Owned',
  host: 'example.test',
  port: 22,
  username: 'deploy'
}
beforeEach(() => {
  state.clients.length = 0
  state.connectError = undefined
  state.disconnectError = undefined
})

it('retains failed startup transport evidence until its disposed connection physically closes', async () => {
  const manager = new SshConnectionManager({ onStateChange: vi.fn() })
  state.connectError = new Error('authentication rejected')
  await expect(manager.connect(target)).rejects.toThrow('authentication rejected')
  expect(state.clients[0].status).toBe('disconnected')
  expect(manager.getConnection(target.id)).toBeUndefined()
  expect(managerTargetActive(manager, target.id)).toBe(false)
  expect(() => assertManagerTargetTransportsClosed(manager, target.id)).toThrow('closure_unproven')
  state.clients[0].close()
  expect(() => assertManagerTargetTransportsClosed(manager, target.id)).not.toThrow()
})

it('requires every allocation and ignores duplicate close notifications', async () => {
  const manager = new SshConnectionManager({ onStateChange: vi.fn() })
  await manager.connect(target)
  await manager.disconnect(target.id)
  await manager.connect(target)
  await manager.disconnect(target.id)
  state.clients[0].close()
  state.clients[0].close()
  expect(() => assertManagerTargetTransportsClosed(manager, target.id)).toThrow('closure_unproven')
  state.clients[1].close()
  expect(() => assertManagerTargetTransportsClosed(manager, target.id)).not.toThrow()
})

it('does not let an old close remove a replacement or taint an unrelated target', async () => {
  const manager = new SshConnectionManager({ onStateChange: vi.fn() })
  await manager.connect(target)
  await manager.disconnect(target.id)
  const replacement = await manager.connect(target)
  state.clients[0].close()
  expect(manager.getConnection(target.id)).toBe(replacement)
  expect(() => assertManagerTargetTransportsClosed(manager, target.id)).toThrow()
  expect(() => assertManagerTargetTransportsClosed(manager, 'unrelated')).not.toThrow()
})

it('releases bookkeeping after repeated observed closure', async () => {
  const manager = new SshConnectionManager({ onStateChange: vi.fn() })
  for (let index = 0; index < 100; index++) {
    await manager.connect(target)
    await manager.disconnect(target.id)
    state.clients[index].close()
    expect(() => assertManagerTargetTransportsClosed(manager, target.id)).not.toThrow()
  }
  expect(managerUnclosedTransportTargets(manager)).toBe(0)
})
