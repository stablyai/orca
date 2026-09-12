import { beforeEach, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'

const state = vi.hoisted(() => ({
  clients: [] as { close: () => void; status: string }[],
  connectError: undefined as Error | undefined,
  disconnectError: undefined as Error | undefined
}))
vi.mock('./profile-lifetime-admission', () => ({ assertProfileLifetimeAdmission: () => {} }))
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

const target = { id: 'owned', label: 'Owned', host: 'example.test' } as SshTarget
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
  expect(manager.hasTargetActivity(target.id)).toBe(false)
  expect(() => manager.assertTargetTransportsClosed(target.id)).toThrow('closure_unproven')
  state.clients[0].close()
  expect(() => manager.assertTargetTransportsClosed(target.id)).not.toThrow()
})

it('does not forgive failed startup cleanup merely because its socket later closes', async () => {
  const manager = new SshConnectionManager({ onStateChange: vi.fn() })
  state.connectError = new Error('authentication rejected')
  state.disconnectError = new Error('cleanup rejected')
  const failure = await manager.connect(target).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toEqual([state.connectError, state.disconnectError])
  state.clients[0].close()
  expect(() => manager.assertTargetTransportsClosed(target.id)).toThrow('closure_unproven')
  expect(() => manager.assertTargetTransportsClosed('unrelated')).not.toThrow()
  await expect(
    manager.connectExclusive(target, {
      signal: new AbortController().signal,
      assertAuthority: () => {}
    })
  ).rejects.toThrow('has_activity')
  expect(state.clients).toHaveLength(1)
})

it('does not infer physical closure from an empty pool after ordinary disconnect', async () => {
  const manager = new SshConnectionManager({ onStateChange: vi.fn() })
  await manager.connect(target)
  await manager.disconnect(target.id)
  expect(manager.hasTargetActivity(target.id)).toBe(false)
  expect(() => manager.assertTargetTransportsClosed(target.id)).toThrow('closure_unproven')
  await expect(
    manager.connectExclusive(target, {
      signal: new AbortController().signal,
      assertAuthority: () => {}
    })
  ).rejects.toThrow('has_activity')
  state.clients[0].close()
  expect(() => manager.assertTargetTransportsClosed(target.id)).not.toThrow()
})

it('requires every allocation and ignores duplicate close notifications', async () => {
  const manager = new SshConnectionManager({ onStateChange: vi.fn() })
  await manager.connect(target)
  await manager.disconnect(target.id)
  await manager.connect(target)
  await manager.disconnect(target.id)
  state.clients[0].close()
  state.clients[0].close()
  expect(() => manager.assertTargetTransportsClosed(target.id)).toThrow('closure_unproven')
  state.clients[1].close()
  expect(() => manager.assertTargetTransportsClosed(target.id)).not.toThrow()
})

it('does not let an old close remove a replacement or taint an unrelated target', async () => {
  const manager = new SshConnectionManager({ onStateChange: vi.fn() })
  await manager.connect(target)
  await manager.disconnect(target.id)
  const replacement = await manager.connect(target)
  state.clients[0].close()
  expect(manager.getConnection(target.id)).toBe(replacement)
  expect(() => manager.assertTargetTransportsClosed(target.id)).toThrow()
  expect(() => manager.assertTargetTransportsClosed('unrelated')).not.toThrow()
})

it('releases bookkeeping after repeated observed closure', async () => {
  const manager = new SshConnectionManager({ onStateChange: vi.fn() })
  for (let index = 0; index < 100; index++) {
    await manager.connect(target)
    await manager.disconnect(target.id)
    state.clients[index].close()
    expect(() => manager.assertTargetTransportsClosed(target.id)).not.toThrow()
  }
  expect(
    (manager as unknown as { unclosedTransportsByTarget: Map<string, number> })
      .unclosedTransportsByTarget.size
  ).toBe(0)
})
