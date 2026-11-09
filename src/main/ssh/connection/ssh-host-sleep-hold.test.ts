import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../../shared/ssh-types'

const created = vi.hoisted(() => ({ count: 0 }))

vi.mock('./ssh-connection', () => ({
  SshConnection: class MockSshConnection {
    status = 'connecting'
    constructor() {
      created.count += 1
    }
    connect = vi.fn(async () => {
      this.status = 'connected'
    })
    disconnect = vi.fn(async () => {})
    getState(): { status: string } {
      return { status: this.status }
    }
    setCallbacks(): void {}
    getReusableCredentials(): null {
      return null
    }
    isAwaitingCredential(): boolean {
      return false
    }
  }
}))

import { SshConnectionManager } from './ssh-connection-manager'
import {
  SshConnectionReconnector,
  type SshConnectionReconnectHost
} from './reconnect/ssh-connection-reconnect'
import { SSH_HOST_ASLEEP_ERROR_CODE, setSshHostAsleepCheck } from './ssh-host-sleep-hold'

const VM_TARGET_ID = 'runtime-ssh-vm-1'

function target(id: string): SshTarget {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked SshConnection reads no target field.
  return { id, label: 'Workspace VM', host: 'vm.test', port: 22, username: 'orca' } as SshTarget
}

function reconnectHost(targetId: string): {
  host: SshConnectionReconnectHost
  attempts: () => number
} {
  let generation = 0
  let attempts = 0
  return {
    attempts: () => attempts,
    host: {
      targetId,
      label: 'Workspace VM',
      isDisposed: () => false,
      status: () => 'disconnected',
      isAwaitingCredential: () => false,
      claimGeneration: () => ++generation,
      currentGeneration: () => generation,
      isCurrentAttempt: (value) => value === generation,
      attemptConnect: async () => {
        attempts += 1
      },
      closeTransportsForReconnect: () => {},
      setReconnectAttempt: () => {},
      setState: () => {}
    }
  }
}

afterEach(() => {
  setSshHostAsleepCheck(null)
  created.count = 0
  vi.useRealTimers()
})

// #36363: an SSH login can wake a paused VM, so an asleep VM's host must take none.
describe('SSH host of a sleeping VM', () => {
  it('refuses a background connect without opening an SSH session', async () => {
    setSshHostAsleepCheck((targetId) => targetId === VM_TARGET_ID)
    const manager = new SshConnectionManager({ onStateChange: vi.fn() })

    await expect(manager.connect(target(VM_TARGET_ID))).rejects.toMatchObject({
      code: SSH_HOST_ASLEEP_ERROR_CODE
    })
    expect(created.count).toBe(0)
  })

  it('connects once the VM is no longer asleep, and never holds other hosts', async () => {
    let asleep = true
    setSshHostAsleepCheck(() => asleep)
    const manager = new SshConnectionManager({ onStateChange: vi.fn() })

    // Only Orca-owned VM hosts are ever held.
    await expect(manager.connect(target('user-host'))).resolves.toBeDefined()
    asleep = false
    await expect(manager.connect(target(VM_TARGET_ID))).resolves.toBeDefined()
    expect(created.count).toBe(2)
  })

  it('stops the reconnect ladder, including a retry armed before the sleep', async () => {
    vi.useFakeTimers()
    let asleep = false
    setSshHostAsleepCheck(() => asleep)
    const { host, attempts } = reconnectHost(VM_TARGET_ID)
    const reconnector = new SshConnectionReconnector(host)

    reconnector.scheduleReconnect()
    asleep = true
    await vi.runAllTimersAsync()
    await reconnector.reconnect()
    expect(reconnector.retryAfterNetworkReturn(Date.now())).toBe(false)
    reconnector.scheduleReconnect()
    await vi.runAllTimersAsync()

    expect(attempts()).toBe(0)
  })

  it('keeps an unreadable VM record from stranding a host', async () => {
    setSshHostAsleepCheck(() => {
      throw new Error('store unreadable')
    })
    const manager = new SshConnectionManager({ onStateChange: vi.fn() })
    await expect(manager.connect(target(VM_TARGET_ID))).resolves.toBeDefined()
  })
})
