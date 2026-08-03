import { describe, expect, it, vi } from 'vitest'

import {
  getSshFilesystemProvider,
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
