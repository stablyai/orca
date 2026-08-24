import { describe, expect, it, vi } from 'vitest'

import {
  getSshFilesystemProvider,
  getSshFilesystemProviderSnapshot,
  onSshFilesystemProviderChanged,
  onSshFilesystemProviderRegistered,
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from './ssh-filesystem-dispatch'
import type { IFilesystemProvider } from './types'

const provider = {} as IFilesystemProvider

describe('onSshFilesystemProviderRegistered', () => {
  it('notifies subscribers on every registration, including a reconnect replacing the provider', () => {
    const listener = vi.fn()
    const unsubscribe = onSshFilesystemProviderRegistered(listener)

    registerSshFilesystemProvider('conn-1', provider)
    registerSshFilesystemProvider('conn-1', {} as IFilesystemProvider)

    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenNthCalledWith(1, 'conn-1')
    expect(listener).toHaveBeenNthCalledWith(2, 'conn-1')

    unsubscribe()
    unregisterSshFilesystemProvider('conn-1')
  })

  it('exposes the new provider to subscribers while they are being notified', () => {
    let seen: IFilesystemProvider | undefined
    const unsubscribe = onSshFilesystemProviderRegistered((connectionId) => {
      seen = getSshFilesystemProvider(connectionId)
    })

    registerSshFilesystemProvider('conn-2', provider)

    expect(seen).toBe(provider)
    unsubscribe()
    unregisterSshFilesystemProvider('conn-2')
  })

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn()
    onSshFilesystemProviderRegistered(listener)()

    registerSshFilesystemProvider('conn-3', provider)

    expect(listener).not.toHaveBeenCalled()
    unregisterSshFilesystemProvider('conn-3')
  })

  it('keeps registration working when a subscriber throws', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const healthy = vi.fn()
    const unsubscribeThrower = onSshFilesystemProviderRegistered(() => {
      throw new Error('subscriber blew up')
    })
    const unsubscribeHealthy = onSshFilesystemProviderRegistered(healthy)

    expect(() => registerSshFilesystemProvider('conn-4', provider)).not.toThrow()
    expect(getSshFilesystemProvider('conn-4')).toBe(provider)
    expect(healthy).toHaveBeenCalledWith('conn-4')

    unsubscribeThrower()
    unsubscribeHealthy()
    unregisterSshFilesystemProvider('conn-4')
    warnSpy.mockRestore()
  })
})

describe('SSH filesystem provider generations', () => {
  it('fences register, unregister, and replacement with monotonic generations', () => {
    const states: { generation: number; provider: IFilesystemProvider | undefined }[] = []
    const unsubscribe = onSshFilesystemProviderChanged((connectionId, generation) => {
      if (connectionId === 'generation-conn') {
        states.push({ generation, provider: getSshFilesystemProvider(connectionId) })
      }
    })
    const replacement = {} as IFilesystemProvider

    try {
      registerSshFilesystemProvider('generation-conn', provider)
      const first = getSshFilesystemProviderSnapshot('generation-conn')
      unregisterSshFilesystemProvider('generation-conn')
      registerSshFilesystemProvider('generation-conn', replacement)
      const third = getSshFilesystemProviderSnapshot('generation-conn')

      expect(states.map((state) => state.generation)).toEqual([
        first!.generation,
        first!.generation + 1,
        first!.generation + 2
      ])
      expect(states.map((state) => state.provider)).toEqual([provider, undefined, replacement])
      expect(third).toEqual({ provider: replacement, generation: first!.generation + 2 })
    } finally {
      unsubscribe()
      unregisterSshFilesystemProvider('generation-conn')
    }
  })
})
