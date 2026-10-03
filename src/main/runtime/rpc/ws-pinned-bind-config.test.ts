import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseWsPinnedBindConfig,
  readWsPinnedBindConfig,
  WS_PINNED_BIND_CONFIG_FILE,
  wsPinnedBindServerOptions
} from './ws-pinned-bind-config'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeUserDataPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-ws-pin-'))
  tempDirs.push(dir)
  return dir
}

describe('readWsPinnedBindConfig', () => {
  it('is unset when the file does not exist, so the default bind policy applies', () => {
    const userDataPath = makeUserDataPath()
    const config = readWsPinnedBindConfig(userDataPath)
    expect(config).toEqual({ status: 'unset' })
    expect(wsPinnedBindServerOptions(config)).toEqual({})
  })

  it('reads a pinned host and port', () => {
    const userDataPath = makeUserDataPath()
    writeFileSync(
      join(userDataPath, WS_PINNED_BIND_CONFIG_FILE),
      JSON.stringify({ host: '127.0.0.1', port: 6768 })
    )
    const config = readWsPinnedBindConfig(userDataPath)
    expect(config).toEqual({ status: 'pinned', host: '127.0.0.1', port: 6768 })
    expect(wsPinnedBindServerOptions(config)).toEqual({
      pinnedBindHost: '127.0.0.1',
      wsPort: 6768,
      strictWsPort: true
    })
  })

  // Why: a present-but-unreadable pin is still an opt-in; treating it as unset would silently restore
  // the default policy, which widens once a network device has connected.
  it('is invalid, not unset, when the file exists but cannot be read', () => {
    const userDataPath = makeUserDataPath()
    mkdirSync(join(userDataPath, WS_PINNED_BIND_CONFIG_FILE))
    expect(readWsPinnedBindConfig(userDataPath).status).toBe('invalid')
  })

  it('reads a file saved with a UTF-8 byte order mark', () => {
    const userDataPath = makeUserDataPath()
    writeFileSync(
      join(userDataPath, WS_PINNED_BIND_CONFIG_FILE),
      '\uFEFF{"host":"127.0.0.1","port":6768}\r\n'
    )
    expect(readWsPinnedBindConfig(userDataPath)).toEqual({
      status: 'pinned',
      host: '127.0.0.1',
      port: 6768
    })
  })
})

describe('parseWsPinnedBindConfig', () => {
  it.each(['127.0.0.1', '127.1.2.3', '::1'])('accepts the loopback literal %s', (host) => {
    expect(parseWsPinnedBindConfig(JSON.stringify({ host, port: 6768 }))).toEqual({
      status: 'pinned',
      host,
      port: 6768
    })
  })

  it.each([
    ['malformed JSON', '{"host":"127.0.0.1",'],
    ['a non-object', '[]'],
    ['a misspelt key', '{"bindHost":"127.0.0.1","port":6768}'],
    ['a hostname, which DNS would resolve', '{"host":"localhost","port":6768}'],
    ['the IPv4 wildcard', '{"host":"0.0.0.0","port":6768}'],
    ['the IPv6 wildcard', '{"host":"::","port":6768}'],
    ['a private LAN address', '{"host":"192.168.1.10","port":6768}'],
    ['a Tailscale address', '{"host":"100.64.1.20","port":6768}'],
    ['a Tailscale IPv6 address', '{"host":"fd7a:115c:a1e0::1","port":6768}'],
    ['an IPv6 link-local address', '{"host":"fe80::1","port":6768}'],
    ['a zoned IPv6 loopback', '{"host":"::1%lo0","port":6768}'],
    ['an expanded IPv6 loopback', '{"host":"0:0:0:0:0:0:0:1","port":6768}'],
    ['an IPv4-mapped loopback', '{"host":"::ffff:127.0.0.1","port":6768}'],
    ['a 127-prefixed hostname', '{"host":"127.example.com","port":6768}'],
    ['a missing host', '{"port":6768}'],
    ['port 0, which asks the OS to relocate', '{"host":"127.0.0.1","port":0}'],
    ['a port above 65535', '{"host":"127.0.0.1","port":65536}'],
    ['a string port', '{"host":"127.0.0.1","port":"6768"}'],
    ['a fractional port', '{"host":"127.0.0.1","port":6768.5}']
  ])('rejects %s', (_label, raw) => {
    expect(parseWsPinnedBindConfig(raw).status).toBe('invalid')
  })

  it('maps an invalid pin to a loopback strict bind that refuses to listen', () => {
    const options = wsPinnedBindServerOptions({ status: 'invalid', reason: 'bad port' })
    expect(options.pinnedBindHost).toBe('127.0.0.1')
    expect(options.strictWsPort).toBe(true)
    expect(options.webSocketConfigError?.message).toContain(WS_PINNED_BIND_CONFIG_FILE)
    expect(options.wsPort).toBeUndefined()
  })
})
