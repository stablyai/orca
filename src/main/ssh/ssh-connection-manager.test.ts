import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'

const mockState = vi.hoisted(() => ({
  assertAdmission: vi.fn(),
  connectResults: [] as Promise<void>[],
  instances: [] as {
    connect: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
    status: 'connecting' | 'connected' | 'disconnected'
  }[]
}))

vi.mock('./profile-lifetime-admission', () => ({
  assertProfileLifetimeAdmission: mockState.assertAdmission
}))

vi.mock('./ssh-connection', () => ({
  SshConnection: class MockSshConnection {
    subscribeTransportClosure = vi.fn(() => () => {})
    status: 'connecting' | 'connected' | 'disconnected' = 'connecting'
    connect = vi.fn(async () => {
      await (mockState.connectResults.shift() ?? Promise.resolve())
      this.status = 'connected'
    })
    disconnect = vi.fn(async () => {
      this.status = 'disconnected'
    })
    reconnect = vi.fn(async () => {})

    constructor() {
      mockState.instances.push(this)
    }

    getState(): { status: 'connecting' | 'connected' | 'disconnected' } {
      return { status: this.status }
    }

    setCallbacks(): void {}
  }
}))

import { SshConnectionManager } from './ssh-connection-manager'

const target = {
  id: 'target-1',
  label: 'Target 1',
  host: 'example.test',
  port: 22,
  username: 'demo',
  source: 'manual'
} as SshTarget

describe('SshConnectionManager', () => {
  it('refuses profile admission before allocating a connection', async () => {
    mockState.assertAdmission.mockImplementationOnce(() => {
      throw new Error('profile_refused')
    })
    const manager = new SshConnectionManager({ onStateChange: vi.fn() })
    await expect(manager.connect(target)).rejects.toThrow('profile_refused')
    expect(mockState.instances).toHaveLength(0)
  })

  it('closes the exact connection when profile authority changes during connect', async () => {
    const opening = Promise.withResolvers<void>()
    mockState.connectResults.push(opening.promise)
    const manager = new SshConnectionManager({ onStateChange: vi.fn() })
    const pending = manager.connect(target)
    mockState.assertAdmission.mockImplementation(() => {
      throw new Error('profile_changed')
    })
    opening.resolve()
    await expect(pending).rejects.toThrow('profile_changed')
    expect(mockState.instances[0].disconnect).toHaveBeenCalledOnce()
    expect(manager.getConnection(target.id)).toBeUndefined()
  })

  it('preserves admission and cleanup failures together after reconnect', async () => {
    const manager = new SshConnectionManager({ onStateChange: vi.fn() })
    await manager.connect(target)
    const admissionError = new Error('profile_changed')
    const cleanupError = new Error('disconnect_failed')
    mockState.assertAdmission
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw admissionError
      })
    mockState.instances[0].disconnect.mockRejectedValueOnce(cleanupError)
    await expect(manager.reconnect(target.id)).rejects.toMatchObject({
      message: 'ssh_profile_admission_cleanup_failed',
      errors: [admissionError, cleanupError]
    })
    expect(manager.hasTargetActivity(target.id)).toBe(true)
  })
  it('reports invalidated pending attempts even after disconnect removes the registration', async () => {
    let reject!: (error: Error) => void
    mockState.connectResults.push(
      new Promise<void>((_resolve, fail) => {
        reject = fail
      })
    )
    const manager = new SshConnectionManager({ onStateChange: vi.fn() })
    const pending = manager.connect(target)
    const rejected = expect(pending).rejects.toThrow('cancelled')
    await manager.disconnect(target.id)
    expect(manager.getConnection(target.id)).toBeUndefined()
    expect(manager.hasTargetActivity(target.id)).toBe(true)
    expect(manager.hasTargetActivity('unrelated')).toBe(false)
    reject(new Error('cancelled'))
    await rejected
    expect(manager.hasTargetActivity(target.id)).toBe(false)
  })

  it('tracks detached exact-connection teardown until its promise settles', async () => {
    const manager = new SshConnectionManager({ onStateChange: vi.fn() })
    const conn = await manager.connect(target)
    await manager.disconnect(target.id)
    let finish!: () => void
    mockState.instances[0].disconnect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const pending = manager.disconnectConnection(target.id, conn)
    expect(manager.hasTargetActivity(target.id)).toBe(true)
    finish()
    await pending
    expect(manager.hasTargetActivity(target.id)).toBe(false)
  })

  it('retains uncertainty after bulk teardown fails and removes the registration', async () => {
    const manager = new SshConnectionManager({ onStateChange: vi.fn() })
    await manager.connect(target)
    mockState.instances[0].disconnect.mockRejectedValueOnce(new Error('close unconfirmed'))
    await manager.disconnectAll()
    expect(manager.getConnection(target.id)).toBeUndefined()
    expect(manager.hasTargetActivity(target.id)).toBe(true)
    expect(manager.hasTargetActivity('unrelated')).toBe(false)
  })

  beforeEach(() => {
    mockState.assertAdmission.mockReset()
    mockState.connectResults.length = 0
    mockState.instances.length = 0
  })

  it('lets disconnect start a new connect before the cancelled attempt settles', async () => {
    let rejectFirst!: (error: Error) => void
    mockState.connectResults.push(
      new Promise<void>((_resolve, reject) => {
        rejectFirst = reject
      }),
      Promise.resolve()
    )
    const manager = new SshConnectionManager({
      onStateChange: vi.fn()
    })

    const firstConnect = manager.connect(target)
    await manager.disconnect(target.id)
    const secondConnection = await manager.connect(target)
    rejectFirst(new Error('cancelled'))

    await expect(firstConnect).rejects.toThrow('cancelled')
    expect(mockState.instances).toHaveLength(2)
    expect(manager.getConnection(target.id)).toBe(secondConnection)
  })

  it('keeps the replacement when the disconnected attempt resolves late', async () => {
    let resolveFirst!: () => void
    mockState.connectResults.push(
      new Promise<void>((resolve) => {
        resolveFirst = resolve
      }),
      Promise.resolve()
    )
    const manager = new SshConnectionManager({
      onStateChange: vi.fn()
    })

    const firstConnect = manager.connect(target)
    await manager.disconnect(target.id)
    const replacement = await manager.connect(target)
    resolveFirst()

    await expect(firstConnect).resolves.not.toBe(replacement)
    expect(mockState.instances[0].disconnect).toHaveBeenCalledOnce()
    expect(await manager.connect(target)).toBe(replacement)
    expect(manager.getConnection(target.id)).toBe(replacement)
  })

  it('closes a late-resolved connection without evicting the replacement', async () => {
    let resolveFirst!: () => void
    mockState.connectResults.push(
      new Promise<void>((resolve) => {
        resolveFirst = resolve
      }),
      Promise.resolve()
    )
    const manager = new SshConnectionManager({ onStateChange: vi.fn() })

    const firstConnect = manager.connect(target)
    await manager.disconnect(target.id)
    const replacement = await manager.connect(target)
    resolveFirst()
    const late = await firstConnect

    await manager.disconnectConnection(target.id, late)

    expect(mockState.instances[0].disconnect).toHaveBeenCalledTimes(2)
    expect(manager.getConnection(target.id)).toBe(replacement)
  })

  it('clears the pool entry when the closed connection is still the registered one', async () => {
    const manager = new SshConnectionManager({ onStateChange: vi.fn() })
    const conn = await manager.connect(target)

    await manager.disconnectConnection(target.id, conn)

    expect(mockState.instances[0].disconnect).toHaveBeenCalledOnce()
    expect(manager.getConnection(target.id)).toBeUndefined()
  })
})
