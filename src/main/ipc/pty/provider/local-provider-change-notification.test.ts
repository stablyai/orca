import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from '../../../providers/types'
import {
  getLocalPtyProvider,
  setLocalPtyProvider,
  subscribeLocalPtyProviderChanges
} from './registry'

const originalProvider = getLocalPtyProvider()

afterEach(() => {
  setLocalPtyProvider(originalProvider)
})

describe('local PTY provider change notification', () => {
  it('notifies active subscribers for every installed provider generation', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeLocalPtyProviderChanges(listener)
    const first = {} as IPtyProvider
    const second = {} as IPtyProvider

    setLocalPtyProvider(first)
    setLocalPtyProvider(second)
    unsubscribe()
    setLocalPtyProvider(originalProvider)

    expect(listener.mock.calls).toEqual([[first], [second]])
  })

  it('keeps provider installation available when one observer throws', () => {
    const error = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const installed = {} as IPtyProvider
    const unsubscribe = subscribeLocalPtyProviderChanges(() => {
      throw new Error('observer-failed')
    })

    expect(() => setLocalPtyProvider(installed)).not.toThrow()
    expect(getLocalPtyProvider()).toBe(installed)
    expect(error).toHaveBeenCalledOnce()

    unsubscribe()
    error.mockRestore()
  })
})
