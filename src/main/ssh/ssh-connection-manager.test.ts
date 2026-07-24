import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'

const mockState = vi.hoisted(() => ({
  connectResults: [] as Promise<void>[],
  instances: [] as {
    connect: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
    status: 'connecting' | 'connected' | 'disconnected'
  }[]
}))

vi.mock('./ssh-connection', () => ({
  SshConnection: class MockSshConnection {
    status: 'connecting' | 'connected' | 'disconnected' = 'connecting'
    connect = vi.fn(async () => {
      await (mockState.connectResults.shift() ?? Promise.resolve())
      this.status = 'connected'
    })
    disconnect = vi.fn(async () => {
      this.status = 'disconnected'
    })

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
  beforeEach(() => {
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
})
