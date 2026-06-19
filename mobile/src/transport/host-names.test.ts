import { describe, expect, it } from 'vitest'
import { getNextHostNameFromHosts } from './host-names'

describe('getNextHostNameFromHosts', () => {
  it('increments the largest numbered default host name', () => {
    expect(
      getNextHostNameFromHosts([
        { name: 'Host 2' },
        { name: 'Custom workstation' },
        { name: 'Host 7' },
        { name: 'Host 3' }
      ])
    ).toBe('Host 8')
  })

  it('handles very large host lists without spreading number arrays', () => {
    const hosts = Array.from({ length: 130_000 }, (_, index) => ({
      name: `Host ${index + 1}`
    }))

    expect(getNextHostNameFromHosts(hosts)).toBe('Host 130001')
  })
})
