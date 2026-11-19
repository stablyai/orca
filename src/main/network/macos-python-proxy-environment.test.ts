// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseSystemProxy } from './macos-python-proxy-environment'

// `scutil --proxy` output, trimmed to the fields the parser reads.
function scutil(entries: readonly string[], exceptions: readonly string[] = []): string {
  return [
    '<dictionary> {',
    ...(exceptions.length
      ? [
          '  ExceptionsList : <array> {',
          ...exceptions.map((entry, index) => `    ${index} : ${entry}`),
          '  }'
        ]
      : []),
    ...entries.map((entry) => `  ${entry}`),
    '}'
  ].join('\n')
}

describe('parseSystemProxy', () => {
  it('maps an ordinary HTTP(S) proxy with representable exclusions', () => {
    const parsed = parseSystemProxy(
      scutil(
        [
          'HTTPEnable : 1',
          'HTTPProxy : proxy.example',
          'HTTPPort : 3128',
          'HTTPSEnable : 1',
          'HTTPSProxy : proxy.example',
          'HTTPSPort : 3129'
        ],
        ['localhost', '127.0.0.1', '*.local', '10.0.0.0/8']
      )
    )
    expect(parsed).toEqual({
      kind: 'environment',
      proxies: { http: 'http://proxy.example:3128', https: 'http://proxy.example:3129' },
      bypass: ['.local']
    })
  })

  it('keeps explicit proxies and exact hostnames, dropping wildcards lossily', () => {
    const parsed = parseSystemProxy(
      scutil(
        ['SOCKSEnable : 1', 'SOCKSProxy : 127.0.0.1', 'SOCKSPort : 7890'],
        ['*.local', '*.example.test', 'timestamp.apple.com', '*google*', '142.250/15']
      )
    )
    expect(parsed).toEqual({
      kind: 'environment',
      proxies: { socks: 'http://127.0.0.1:7890' },
      // *.local maps exactly; exact hostnames stay direct; bare/mid-string wildcards and
      // non-private ranges are dropped (NO_PROXY would over-bypass their apexes).
      bypass: ['.local', 'timestamp.apple.com'],
      lossy: true
    })
  })

  it('marks PAC-only configurations as unrepresentable', () => {
    const parsed = parseSystemProxy(
      scutil([
        'ProxyAutoConfigEnable : 1',
        'ProxyAutoConfigURLString : http://pac.example/proxy.pac'
      ])
    )
    expect(parsed).toEqual({ kind: 'unrepresentable' })
  })

  it('keeps explicit proxies with lossy: true when PAC is enabled alongside a static proxy', () => {
    const parsed = parseSystemProxy(
      scutil([
        'ProxyAutoConfigEnable : 1',
        'ProxyAutoConfigURLString : http://pac.example/proxy.pac',
        'SOCKSEnable : 1',
        'SOCKSProxy : 127.0.0.1',
        'SOCKSPort : 7890'
      ])
    )
    expect(parsed).toEqual({
      kind: 'environment',
      proxies: { socks: 'http://127.0.0.1:7890' },
      bypass: [],
      lossy: true
    })
  })

  it('returns null when no proxy is enabled', () => {
    expect(
      parseSystemProxy(
        scutil(['HTTPEnable : 0', 'HTTPSEnable : 0', 'SOCKSEnable : 0'], ['*.example.test'])
      )
    ).toBe(null)
  })

  it('returns null for output that is not a proxy dictionary', () => {
    expect(parseSystemProxy('not a dictionary')).toBe(null)
  })
})
