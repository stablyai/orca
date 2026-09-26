import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatAgentCliFailureMessage } from '../text-generation/source-control-agent-failure'
import {
  __resetMacTailscaleDnsDiagnosticCacheForTests,
  withMacTailscaleDnsHint
} from './macos-tailscale-dns-diagnostic'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))

const MAGIC_DNS = 'DNS configuration\n  nameserver[0] : 100.100.100.100\n'
const PUBLIC_DNS = 'DNS configuration\n  nameserver[0] : 1.1.1.1\n'

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  vi.spyOn(Date, 'now').mockReturnValue(1_000)
  vi.mocked(execFileSync).mockReset().mockReturnValue(MAGIC_DNS)
  __resetMacTailscaleDnsDiagnosticCacheForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
  __resetMacTailscaleDnsDiagnosticCacheForTests()
})

describe('macOS DNS probe admission', () => {
  it.each(['permission denied', 'authentication failed', 'PTY timeout', '', 'invalid JSON'])(
    'does not probe for an unrelated error: %s',
    (detail) => {
      expect(withMacTailscaleDnsHint('Codex failed.', detail)).toBe('Codex failed.')
      expect(execFileSync).not.toHaveBeenCalled()
    }
  )

  it.each([
    'ENOTFOUND',
    'eai_again',
    'lookup address',
    'DNS failure',
    'websocket',
    'connection refused'
  ])('still diagnoses a relevant detail: %s', (detail) => {
    expect(withMacTailscaleDnsHint('Codex failed.', detail)).toContain('Tailscale MagicDNS')
    expect(execFileSync).toHaveBeenCalledOnce()
  })

  it('recognizes a relevant message without detail', () => {
    expect(withMacTailscaleDnsHint('ERR_NAME_NOT_RESOLVED')).toContain('Tailscale MagicDNS')
    expect(execFileSync).toHaveBeenCalledOnce()
  })

  it.each(['linux', 'win32'] as const)('never probes on %s', (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    expect(withMacTailscaleDnsHint('ENOTFOUND')).toBe('ENOTFOUND')
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('does not warm the diagnostic cache for an unrelated failure', () => {
    vi.mocked(execFileSync).mockReturnValue(PUBLIC_DNS)
    withMacTailscaleDnsHint('permission denied')
    expect(execFileSync).not.toHaveBeenCalled()

    vi.mocked(execFileSync).mockReturnValue(MAGIC_DNS)
    expect(withMacTailscaleDnsHint('ENOTFOUND')).toContain('Tailscale MagicDNS')
    expect(execFileSync).toHaveBeenCalledOnce()
  })

  it('keeps the five-minute cache for relevant errors and skips unrelated expiry probes', () => {
    expect(withMacTailscaleDnsHint('ENOTFOUND')).toContain('Tailscale MagicDNS')
    vi.mocked(Date.now).mockReturnValue(300_999)
    expect(withMacTailscaleDnsHint('ENOTFOUND')).toContain('Tailscale MagicDNS')
    expect(execFileSync).toHaveBeenCalledOnce()

    vi.mocked(Date.now).mockReturnValue(301_000)
    withMacTailscaleDnsHint('permission denied')
    expect(execFileSync).toHaveBeenCalledOnce()
    vi.mocked(execFileSync).mockReturnValue(PUBLIC_DNS)
    expect(withMacTailscaleDnsHint('ENOTFOUND')).toBe('ENOTFOUND')
    expect(execFileSync).toHaveBeenCalledTimes(2)
  })

  it.each(['empty output', 'failed command'])('retains negative caching for %s', (failure) => {
    vi.mocked(execFileSync).mockImplementation(() => {
      if (failure === 'failed command') {
        throw new Error('probe failed')
      }
      return ''
    })
    expect(withMacTailscaleDnsHint('ENOTFOUND')).toBe('ENOTFOUND')
    expect(withMacTailscaleDnsHint('EAI_AGAIN')).toBe('EAI_AGAIN')
    expect(execFileSync).toHaveBeenCalledOnce()
  })

  it('avoids probing while formatting a local CLI permission failure', () => {
    expect(formatAgentCliFailureMessage('Codex', '', 'permission denied', 1)).toBe(
      'Codex CLI command failed with code 1: permission denied'
    )
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('keeps local network hints and honors the remote host opt-out', () => {
    expect(
      formatAgentCliFailureMessage('Codex', '', 'ENOTFOUND', 1, { includeLocalMacDnsHint: false })
    ).toBe('Codex CLI command failed with code 1: ENOTFOUND')
    expect(execFileSync).not.toHaveBeenCalled()
    expect(formatAgentCliFailureMessage('Codex', '', 'ENOTFOUND', 1)).toContain(
      'Tailscale MagicDNS'
    )
    expect(execFileSync).toHaveBeenCalledOnce()
  })
})
