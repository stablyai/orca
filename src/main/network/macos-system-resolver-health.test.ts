import { describe, expect, it } from 'vitest'
import { classifyMacSystemResolverHealth } from './macos-system-resolver-health'

describe('classifyMacSystemResolverHealth', () => {
  it('treats the macOS no-resolver output as unhealthy', () => {
    expect(classifyMacSystemResolverHealth('No DNS configuration available\n')).toBe('unhealthy')
  })

  it('treats scutil DNS output with nameservers as healthy', () => {
    expect(
      classifyMacSystemResolverHealth(`
DNS configuration

resolver #1
  nameserver[0] : 1.1.1.1
  flags    : Request A records
`)
    ).toBe('healthy')
  })

  it('fails open when the resolver output is inconclusive', () => {
    expect(classifyMacSystemResolverHealth('')).toBe('unknown')
  })
})
