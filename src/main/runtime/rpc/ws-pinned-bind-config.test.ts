import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseWsPinnedBindConfig,
  readWsPinnedBindConfig,
  WS_PINNED_BIND_CONFIG_FILE,
  wsPinnedBindServerOptions
} from './ws-pinned-bind-config'

describe('readWsPinnedBindConfig', () => {
  it('is unset when the file does not exist, so the default bind policy applies', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-ws-pin-'))
    const config = readWsPinnedBindConfig(userDataPath)
    expect(config).toEqual({ status: 'unset' })
    expect(wsPinnedBindServerOptions(config)).toEqual({})
  })

  it('reads a pinned host and port', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-ws-pin-'))
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
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-ws-pin-'))
    mkdirSync(join(userDataPath, WS_PINNED_BIND_CONFIG_FILE))
    expect(readWsPinnedBindConfig(userDataPath).status).toBe('invalid')
  })
})

describe('parseWsPinnedBindConfig', () => {
  it('accepts an IPv6 literal', () => {
    expect(parseWsPinnedBindConfig('{"host":"::1","port":6768}')).toEqual({
      status: 'pinned',
      host: '::1',
      port: 6768
    })
  })

  it.each([
    ['malformed JSON', '{"host":"127.0.0.1",'],
    ['a non-object', '[]'],
    ['a misspelt key', '{"bindHost":"127.0.0.1","port":6768}'],
    ['a hostname, which DNS would resolve', '{"host":"localhost","port":6768}'],
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
