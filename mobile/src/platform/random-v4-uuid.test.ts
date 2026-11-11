import { afterEach, describe, expect, it, vi } from 'vitest'

const secure = vi.hoisted(() => ({
  getRandomBytes: vi.fn((count: number) => new Uint8Array(count).fill(0xff))
}))
vi.mock('expo-crypto', () => secure)

import { randomV4Uuid } from './random-v4-uuid'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('randomV4Uuid', () => {
  it('uses crypto.randomUUID where the platform has it', () => {
    const randomUUID = vi.fn(() => '11111111-1111-4111-8111-111111111111')
    vi.stubGlobal('crypto', { randomUUID })
    expect(randomV4Uuid()).toBe('11111111-1111-4111-8111-111111111111')
    expect(secure.getRandomBytes).not.toHaveBeenCalled()
  })

  it('falls back to the secure byte source, never Math.random, and stamps v4', () => {
    vi.stubGlobal('crypto', {})
    const insecure = vi.spyOn(Math, 'random')
    expect(randomV4Uuid()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff')
    expect(secure.getRandomBytes).toHaveBeenCalledWith(16)
    expect(insecure).not.toHaveBeenCalled()
  })
})
