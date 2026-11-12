import { describe, expect, it, vi } from 'vitest'
import { pageFaultLine } from './shell-lifecycle-log'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) }
}))

describe('shell failure details', () => {
  it('keeps device paths out of a page fault', () => {
    expect(
      pageFaultLine({
        category: 'TypeError',
        message: 'x is undefined at file:///var/mobile/app/index.js:1\n    at /Users/me/secret.js',
        isRpcDeliveryUnknown: false
      }).detail
    ).toBe('TypeError: x is undefined at [path]')
  })
})
