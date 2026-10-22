import { afterEach, describe, expect, it, vi } from 'vitest'

const switchState = vi.hoisted(() => ({ on: true }))
vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return switchState.on
  }
}))

import { rebindLocalProviderListeners } from './listener-lifecycle'
import { onLocalPtyProviderRebound } from './local-provider-rebound'

afterEach(() => {
  switchState.on = true
})

describe('a replaced terminal provider (a terminal service restart)', () => {
  it('tells main to show the live terminals it reports, in a layout-owner build', () => {
    const listener = vi.fn()
    const stop = onLocalPtyProviderRebound(listener)
    rebindLocalProviderListeners()
    stop()
    rebindLocalProviderListeners()
    expect(listener).toHaveBeenCalledOnce()
  })

  it('tells no one in a window-owned build', () => {
    switchState.on = false
    const listener = vi.fn()
    const stop = onLocalPtyProviderRebound(listener)
    rebindLocalProviderListeners()
    stop()
    expect(listener).not.toHaveBeenCalled()
  })

  it('one failing listener does not stop the others', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const later = vi.fn()
    const stops = [
      onLocalPtyProviderRebound(() => {
        throw new Error('boom')
      }),
      onLocalPtyProviderRebound(later)
    ]
    rebindLocalProviderListeners()
    stops.forEach((stop) => stop())
    expect(later).toHaveBeenCalledOnce()
  })
})
