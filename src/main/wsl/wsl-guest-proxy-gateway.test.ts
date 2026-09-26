import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WslSpec, WslResult } from './wsl-runner'

const runWslProcessMock = vi.hoisted(() => vi.fn<(spec: WslSpec) => Promise<WslResult>>())

vi.mock('./wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import {
  _resetWslGuestProxyCachesForTests,
  buildWslGatewayProbeScript,
  buildWslProxyProbeScript,
  isLoopbackProxyHostname,
  parseWslGatewayProbeOutput,
  parseWslProxyProbeOutput,
  replaceProxyHostname,
  resolveWslGuestProxySettings
} from './wsl-guest-proxy-gateway'

const GATEWAY_SCRIPT_MARKER = 'ip route show default'

// Why: the resolver early-returns off win32, but CI's unit lane runs on Linux.
const originalPlatform = process.platform
beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
})
afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

function wslResult(stdout: string): Promise<WslResult> {
  return Promise.resolve({
    environmentResolved: true,
    code: 0,
    stdout,
    stderr: '',
    timedOut: false
  })
}

/** Answer gateway lookups and /dev/tcp probes by script content. */
function scriptRoutes(routes: { match: string; stdout: string }[]): void {
  runWslProcessMock.mockImplementation((spec: WslSpec) => {
    const script = spec.script ?? ''
    const route = routes.find((candidate) => script.includes(candidate.match))
    return wslResult(route?.stdout ?? 'unreachable')
  })
}

function probeTargets(): string[] {
  return runWslProcessMock.mock.calls.map(([spec]) => {
    const match = /\/dev\/tcp\/(\S+?)\/(\d+)/.exec(spec.script ?? '')
    return match ? `${match[1].replace(/['\\]/g, '')}/${match[2]}` : 'gateway'
  })
}

beforeEach(() => {
  _resetWslGuestProxyCachesForTests()
  runWslProcessMock.mockReset()
})

describe('isLoopbackProxyHostname', () => {
  it.each([
    ['localhost', true],
    ['LOCALHOST', true],
    ['127.0.0.1', true],
    ['127.255.1.2', true],
    ['::1', true],
    ['[::1]', true],
    ['128.0.0.1', false],
    ['172.28.112.1', false],
    ['::2', false],
    ['proxy.example.com', false],
    ['', false]
  ])('%s → %s', (hostname, expected) => {
    expect(isLoopbackProxyHostname(hostname)).toBe(expected)
  })
})

describe('replaceProxyHostname', () => {
  it('replaces the hostname and keeps port, credentials and scheme', () => {
    expect(replaceProxyHostname('http://127.0.0.1:7890', '172.28.112.193')).toBe(
      'http://172.28.112.193:7890/'
    )
    expect(replaceProxyHostname('socks5://user:pass@localhost:1080', '172.16.0.1')).toBe(
      'socks5://user:pass@172.16.0.1:1080'
    )
  })

  it('brackets an IPv6 gateway', () => {
    expect(replaceProxyHostname('http://127.0.0.1:7890', 'fd00::1')).toBe('http://[fd00::1]:7890/')
  })
})

describe('buildWslProxyProbeScript', () => {
  it('probes the explicit port', () => {
    const script = buildWslProxyProbeScript('http://127.0.0.1:7890')
    // Why the escaped form: the host is POSIX-quoted inside the probe script
    // (command-substitution hardening), which renders the quote-splice as
    // backslash-escaped single quotes around the token.
    expect(script).toContain(String.raw`/dev/tcp/'\''127.0.0.1'\''/7890`)
    expect(script).toContain('printf reachable')
  })

  it('defaults the port from the scheme', () => {
    expect(buildWslProxyProbeScript('https://localhost')).toContain(
      String.raw`/dev/tcp/'\''localhost'\''/443`
    )
    expect(buildWslProxyProbeScript('http://localhost')).toContain(
      String.raw`/dev/tcp/'\''localhost'\''/80`
    )
  })

  it('probes bare IPv6 hosts (/dev/tcp rejects bracketed literals)', () => {
    expect(buildWslProxyProbeScript('http://[::1]:7890')).toContain(
      String.raw`/dev/tcp/'\''::1'\''/7890`
    )
  })
})

describe('parseWslProxyProbeOutput', () => {
  it.each([
    ['reachable', true],
    ['unreachable', false],
    ['', undefined],
    ['something else', undefined]
  ])('%s → %s', (output, expected) => {
    expect(parseWslProxyProbeOutput(output)).toBe(expected)
  })
})

describe('buildWslGatewayProbeScript', () => {
  it('reads the default route and resolv.conf nameservers', () => {
    const script = buildWslGatewayProbeScript()
    expect(script).toContain('ip route show default')
    expect(script).toContain('/etc/resolv.conf')
    expect(script).toContain('route=%s')
    expect(script).toContain('resolv=')
  })
})

describe('parseWslGatewayProbeOutput', () => {
  it('prefers the default route', () => {
    expect(parseWslGatewayProbeOutput('route=172.28.112.193 resolv=172.28.112.193')).toBe(
      '172.28.112.193'
    )
  })

  it('falls back to a private resolv.conf nameserver', () => {
    expect(parseWslGatewayProbeOutput('resolv=172.28.112.193')).toBe('172.28.112.193')
  })

  it('rejects a public resolv.conf nameserver', () => {
    expect(parseWslGatewayProbeOutput('resolv=8.8.8.8')).toBeNull()
  })

  it('rejects a loopback route and falls back to resolv', () => {
    expect(parseWslGatewayProbeOutput('route=127.0.0.1 resolv=192.168.1.1')).toBe('192.168.1.1')
    expect(parseWslGatewayProbeOutput('route=127.0.0.1 resolv=8.8.8.8')).toBeNull()
  })

  it('accepts IPv6 private and link-local candidates', () => {
    expect(parseWslGatewayProbeOutput('route=fd00::1')).toBe('fd00::1')
    expect(parseWslGatewayProbeOutput('resolv=fe80::1')).toBe('fe80::1')
    expect(parseWslGatewayProbeOutput('resolv=2001:db8::1')).toBeNull()
  })

  it('rejects non-address tokens', () => {
    expect(parseWslGatewayProbeOutput('gateway=')).toBeNull()
    expect(parseWslGatewayProbeOutput('')).toBeNull()
  })
})

describe('buildWslProxyProbeScript injection hardening', () => {
  it('quotes the hostname so command substitutions cannot expand in the nested bash', () => {
    const script = buildWslProxyProbeScript('http://x$(id):7890')
    expect(script).toContain("'x$(id)'")
  })
})

describe('resolveWslGuestProxySettings', () => {
  const settings = {
    httpProxyUrl: 'http://127.0.0.1:7890',
    httpProxyBypassRules: 'internal.example.com'
  }

  it('runs the probe inside the target distro over bash without the login PATH', async () => {
    scriptRoutes([{ match: "127.0.0.1'\\''/7890", stdout: 'reachable' }])
    await resolveWslGuestProxySettings(settings, { isWsl: true, distro: 'Ubuntu' })
    expect(runWslProcessMock).toHaveBeenCalledWith({
      script: expect.stringContaining(String.raw`/dev/tcp/'\''127.0.0.1'\''/7890`),
      shell: 'bash',
      distro: 'Ubuntu',
      loginPath: 'none',
      timeoutMs: 5000
    })
  })

  it('passes settings through untouched when the shell is not WSL', async () => {
    const resolved = await resolveWslGuestProxySettings(settings, { isWsl: false })
    expect(resolved.settings).toBe(settings)
    expect(resolved.crossesBoundary).toBe(false)
    expect(runWslProcessMock).not.toHaveBeenCalled()
  })

  it('crosses a non-loopback proxy into the guest without probing', async () => {
    const resolved = await resolveWslGuestProxySettings(
      { httpProxyUrl: 'http://192.168.1.10:7890' },
      { isWsl: true }
    )
    expect(resolved.settings).toEqual({ httpProxyUrl: 'http://192.168.1.10:7890' })
    expect(resolved.crossesBoundary).toBe(true)
    expect(runWslProcessMock).not.toHaveBeenCalled()
  })

  it('passes settings through and does not cross when no proxy is configured', async () => {
    const resolved = await resolveWslGuestProxySettings({}, { isWsl: true })
    expect(resolved.settings).toEqual({})
    expect(resolved.crossesBoundary).toBe(false)
    expect(runWslProcessMock).not.toHaveBeenCalled()
  })

  it('crosses the loopback URL when the guest can reach it (mirrored networking)', async () => {
    scriptRoutes([{ match: "127.0.0.1'\\''/7890", stdout: 'reachable' }])
    const resolved = await resolveWslGuestProxySettings(settings, { isWsl: true })
    // Why crosses: a guest-confirmed loopback works inside the distro, so the
    // user's URL must still be forwarded via WSLENV instead of being dropped.
    expect(resolved.settings).toBe(settings)
    expect(resolved.crossesBoundary).toBe(true)
    expect(probeTargets()).toEqual(['127.0.0.1/7890'])
  })

  it('rewrites a loopback proxy to the host gateway when the guest confirms the rewrite', async () => {
    scriptRoutes([
      { match: "127.0.0.1'\\''/7890", stdout: 'unreachable' },
      { match: GATEWAY_SCRIPT_MARKER, stdout: 'route=172.28.112.193 resolv=172.28.112.193' },
      { match: "172.28.112.193'\\''/7890", stdout: 'reachable' }
    ])
    const resolved = await resolveWslGuestProxySettings(settings, { isWsl: true, distro: 'Ubuntu' })
    expect(resolved.settings).toEqual({
      httpProxyUrl: 'http://172.28.112.193:7890/',
      httpProxyBypassRules: 'internal.example.com'
    })
    expect(resolved.crossesBoundary).toBe(true)
    expect(probeTargets()).toEqual(['127.0.0.1/7890', 'gateway', '172.28.112.193/7890'])
  })

  it('keeps the original URL but does not cross when the gateway rewrite is unreachable', async () => {
    scriptRoutes([
      { match: "127.0.0.1'\\''/7890", stdout: 'unreachable' },
      { match: GATEWAY_SCRIPT_MARKER, stdout: 'route=172.28.112.193' },
      { match: "172.28.112.193'\\''/7890", stdout: 'unreachable' }
    ])
    const resolved = await resolveWslGuestProxySettings(settings, { isWsl: true })
    expect(resolved.settings).toBe(settings)
    expect(resolved.crossesBoundary).toBe(false)
  })

  it('keeps the original URL but does not cross when no gateway can be resolved', async () => {
    scriptRoutes([
      { match: "127.0.0.1'\\''/7890", stdout: 'unreachable' },
      { match: GATEWAY_SCRIPT_MARKER, stdout: 'gateway=' }
    ])
    const resolved = await resolveWslGuestProxySettings(settings, { isWsl: true })
    expect(resolved.settings).toBe(settings)
    expect(resolved.crossesBoundary).toBe(false)
  })

  it('keeps the original URL but does not cross when the guest probes fail (wsl.exe busy)', async () => {
    runWslProcessMock.mockRejectedValue(new Error('wsl.exe timed out'))
    const resolved = await resolveWslGuestProxySettings(settings, { isWsl: true })
    // Why not cross: an errored probe cannot confirm the loopback is reachable,
    // so an unverified loopback stays out of the guest (pre-series behavior).
    expect(resolved.settings).toBe(settings)
    expect(resolved.crossesBoundary).toBe(false)
  })

  it('caches the loopback verdict across spawns', async () => {
    scriptRoutes([{ match: "127.0.0.1'\\''/7890", stdout: 'reachable' }])
    await resolveWslGuestProxySettings(settings, { isWsl: true })
    await resolveWslGuestProxySettings(settings, { isWsl: true })
    expect(probeTargets()).toEqual(['127.0.0.1/7890'])
  })

  it('reuses the cached gateway for another proxy URL on the same distro', async () => {
    scriptRoutes([
      { match: "127.0.0.1'\\''/7890", stdout: 'unreachable' },
      { match: "localhost'\\''/7890", stdout: 'unreachable' },
      { match: GATEWAY_SCRIPT_MARKER, stdout: 'route=172.28.112.193' },
      { match: "172.28.112.193'\\''/7890", stdout: 'reachable' }
    ])
    const first = await resolveWslGuestProxySettings(settings, { isWsl: true, distro: 'Ubuntu' })
    const second = await resolveWslGuestProxySettings(
      { httpProxyUrl: 'http://localhost:7890' },
      { isWsl: true, distro: 'Ubuntu' }
    )
    expect(first.settings).toEqual({
      httpProxyUrl: 'http://172.28.112.193:7890/',
      httpProxyBypassRules: 'internal.example.com'
    })
    expect(second.settings).toEqual({ httpProxyUrl: 'http://172.28.112.193:7890/' })
    // Why the last probe is absent: the rewritten URL is shared with the first
    // resolution, so its cached verdict answers the second call directly.
    expect(probeTargets()).toEqual([
      '127.0.0.1/7890',
      'gateway',
      '172.28.112.193/7890',
      'localhost/7890'
    ])
  })

  it('resolves the gateway separately per distro', async () => {
    scriptRoutes([
      { match: "127.0.0.1'\\''/7890", stdout: 'unreachable' },
      { match: GATEWAY_SCRIPT_MARKER, stdout: 'route=172.28.112.193' },
      { match: "172.28.112.193'\\''/7890", stdout: 'reachable' }
    ])
    await resolveWslGuestProxySettings(settings, { isWsl: true, distro: 'Ubuntu' })
    await resolveWslGuestProxySettings(settings, { isWsl: true, distro: 'Debian' })
    expect(probeTargets()).toEqual([
      '127.0.0.1/7890',
      'gateway',
      '172.28.112.193/7890',
      '127.0.0.1/7890',
      'gateway',
      '172.28.112.193/7890'
    ])
  })
})
