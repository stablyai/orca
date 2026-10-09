import { describe, expect, it } from 'vitest'
import { HarmonySdkState } from './harmony-sdk-state'
import type { HarmonySdkPaths } from './harmony-sdk-discovery'

const SDK: HarmonySdkPaths = {
  sdkRoot: '/sdk',
  hdc: '/sdk/hdc',
  emulator: '/sdk/Emulator'
}

describe('HarmonySdkState', () => {
  it('returns the injected SDK and treats it as fixed', () => {
    const state = new HarmonySdkState(true, SDK)
    expect(state.resolve()).toBe(SDK)
    expect(state.require()).toBe(SDK)
  })

  it('returns null for an injected missing SDK and require throws', () => {
    const state = new HarmonySdkState(true, null)
    expect(state.resolve()).toBeNull()
    expect(() => state.require()).toThrow(
      expect.objectContaining({
        code: 'emulator_error',
        message: expect.stringContaining('DevEco Studio')
      })
    )
  })
})
