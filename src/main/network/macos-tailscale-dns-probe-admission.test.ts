import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatAgentCliFailureMessage } from '../text-generation/source-control-agent-failure'
import {
  __resetMacTailscaleDnsDiagnosticCacheForTests,
  parseMacTailscaleDnsDiagnostic,
  withMacTailscaleDnsHint,
  withMacTailscaleDnsHintForDiagnostic
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

  it('reuses the sample inside the five-minute window and refreshes it after', () => {
    expect(withMacTailscaleDnsHint('ENOTFOUND')).toContain('Tailscale MagicDNS')

    vi.mocked(Date.now).mockReturnValue(300_999)
    vi.mocked(execFileSync).mockReturnValue(PUBLIC_DNS)
    expect(withMacTailscaleDnsHint('ENOTFOUND')).toContain('Tailscale MagicDNS')

    vi.mocked(Date.now).mockReturnValue(301_000)
    expect(withMacTailscaleDnsHint('permission denied')).toBe('permission denied')
    // The invariant is the resolver state the next relevant error reports, not the probe count.
    expect(withMacTailscaleDnsHint('ENOTFOUND')).toBe('ENOTFOUND')
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

  it.each([
    'EAI_NONAME',
    'EAI_FAIL',
    'ENODATA',
    'getaddrinfo failed',
    'could not resolve host orca.example',
    'Name or service not known',
    'ERR_NAME_RESOLUTION_FAILED',
    'Temporary failure in name resolution'
  ])('diagnoses the resolution failure wording %s', (detail) => {
    expect(withMacTailscaleDnsHint('Codex failed.', detail)).toContain('Tailscale MagicDNS')
  })

  it('never lets probe admission change the message the hint decision would produce', () => {
    const diagnostic = parseMacTailscaleDnsDiagnostic(MAGIC_DNS)
    const details = [
      'permission denied',
      'authentication failed',
      'PTY timeout',
      'invalid JSON',
      '',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EAI_NONAME',
      'getaddrinfo failed',
      'could not resolve host orca.example',
      'connection refused',
      'websocket closed'
    ]

    for (const detail of details) {
      __resetMacTailscaleDnsDiagnosticCacheForTests()
      expect(withMacTailscaleDnsHint('Codex failed.', detail)).toBe(
        withMacTailscaleDnsHintForDiagnostic('Codex failed.', detail, diagnostic)
      )
    }
  })

  it('does not append or re-probe for a message that already carries the hint', () => {
    const hinted = withMacTailscaleDnsHint('Codex failed.', 'ENOTFOUND')
    expect(execFileSync).toHaveBeenCalledOnce()
    // Past the cache window, so a second probe would run if the hint were re-admitted.
    vi.mocked(Date.now).mockReturnValue(301_000)

    expect(withMacTailscaleDnsHint(hinted, 'ENOTFOUND')).toBe(hinted)
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
