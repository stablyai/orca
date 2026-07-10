import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetMacTailscaleDnsDiagnosticCacheForTests,
  parseMacTailscaleDnsDiagnostic,
  withMacTailscaleDnsHint,
  withMacTailscaleDnsHintForDiagnostic
} from './macos-tailscale-dns-diagnostic'

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn()
}))

const MAGIC_DNS_ONLY_SCUTIL = `
DNS configuration

resolver #1
  nameserver[0] : 100.100.100.100
  flags    : Request A records
  reach    : 0x00000002 (Reachable)
  order    : 5000

DNS configuration (for scoped queries)

resolver #1
  nameserver[0] : 192.168.1.1
  if_index : 14 (en0)
`

describe('parseMacTailscaleDnsDiagnostic', () => {
  it('detects Tailscale MagicDNS as the only global resolver', () => {
    const diagnostic = parseMacTailscaleDnsDiagnostic(MAGIC_DNS_ONLY_SCUTIL)

    expect(diagnostic).toEqual({ globalNameservers: ['100.100.100.100'] })
  })

  it('ignores configurations with non-Tailscale global resolvers', () => {
    const diagnostic = parseMacTailscaleDnsDiagnostic(`
DNS configuration

resolver #1
  nameserver[0] : 100.100.100.100
  nameserver[1] : 1.1.1.1
  order    : 5000
`)

    expect(diagnostic).toBeNull()
  })

  it('does not treat scoped-only Tailscale resolvers as the global failure shape', () => {
    const diagnostic = parseMacTailscaleDnsDiagnostic(`
DNS configuration

resolver #1
  nameserver[0] : 192.168.1.1
  order    : 5000

DNS configuration (for scoped queries)

resolver #1
  nameserver[0] : 100.100.100.100
  if_index : 19 (utun7)
`)

    expect(diagnostic).toBeNull()
  })
})

describe('withMacTailscaleDnsHintForDiagnostic', () => {
  it('adds a Tailscale DNS hint for the Codex lookup failure from the issue', () => {
    const diagnostic = parseMacTailscaleDnsDiagnostic(MAGIC_DNS_ONLY_SCUTIL)
    const result = withMacTailscaleDnsHintForDiagnostic(
      'Codex failed. Check the agent CLI configuration and try again.',
      'stream disconnected before completion: failed to lookup address information: nodename nor servname provided, or not known',
      diagnostic
    )

    expect(result).toContain('Tailscale MagicDNS (100.100.100.100)')
    expect(result).toContain('add an upstream DNS server')
  })

  it('leaves unrelated failures unchanged even under MagicDNS-only DNS', () => {
    const diagnostic = parseMacTailscaleDnsDiagnostic(MAGIC_DNS_ONLY_SCUTIL)
    const message = 'Codex failed. Check the agent CLI configuration and try again.'

    expect(withMacTailscaleDnsHintForDiagnostic(message, 'permission denied', diagnostic)).toBe(
      message
    )
  })
})

describe('withMacTailscaleDnsHint', () => {
  const originalPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    vi.mocked(execFileSync).mockReset()
    __resetMacTailscaleDnsDiagnosticCacheForTests()
  })

  it('reads macOS DNS state through the system scutil path', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    vi.mocked(execFileSync).mockReturnValue(MAGIC_DNS_ONLY_SCUTIL)

    const result = withMacTailscaleDnsHint('Codex failed.', 'dns lookup failed')

    expect(result).toContain('Tailscale MagicDNS (100.100.100.100)')
    expect(execFileSync).toHaveBeenCalledWith(
      '/usr/sbin/scutil',
      ['--dns'],
      expect.objectContaining({
        encoding: 'utf8',
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    )
  })
})
