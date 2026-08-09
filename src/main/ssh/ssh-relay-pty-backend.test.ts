import { describe, expect, it } from 'vitest'
import {
  assertRelayPtyBackend,
  parseRemoteZmxPath,
  relayPtyBackendLaunchArgs
} from './ssh-relay-pty-backend'

describe('SSH relay PTY backend', () => {
  it('requires reset before changing a live relay backend', () => {
    expect(() => assertRelayPtyBackend('ALIVE:relay', 'zmx')).toThrow('Reset Relay to apply zmx')
    expect(() => assertRelayPtyBackend('ALIVE:zmx', 'zmx')).not.toThrow()
    expect(() => assertRelayPtyBackend('DEAD', 'zmx')).not.toThrow()
  })

  it('fences a relay launch over surviving zmx sessions of a dead relay', () => {
    expect(() => assertRelayPtyBackend('DEAD:zmx', 'relay')).toThrow(
      'durable zmx terminals from a previous session'
    )
    expect(() => assertRelayPtyBackend('DEAD:zmx', 'zmx')).not.toThrow()
    expect(() => assertRelayPtyBackend('DEAD:relay', 'relay')).not.toThrow()
    expect(() => assertRelayPtyBackend('DEAD:relay', 'zmx')).not.toThrow()
    expect(() => assertRelayPtyBackend('DEAD', 'relay')).not.toThrow()
  })

  it('accepts one absolute zmx path from the remote login shell', () => {
    expect(parseRemoteZmxPath(' /usr/local/bin/zmx\n')).toBe('/usr/local/bin/zmx')
    expect(() => parseRemoteZmxPath('')).toThrow('not found in the remote login PATH')
    expect(() => parseRemoteZmxPath('/usr/bin/zmx\n/other/zmx')).toThrow(
      'not found in the remote login PATH'
    )
    // Why: only a path whose final component is the zmx binary may launch.
    expect(() => parseRemoteZmxPath('/home/user/dotfiles')).toThrow(
      'not found in the remote login PATH'
    )
  })

  it('builds launch flags only for zmx', () => {
    const escape = (value: string): string => `'${value}'`
    expect(relayPtyBackendLaunchArgs('relay', undefined, escape)).toBe('')
    expect(relayPtyBackendLaunchArgs('zmx', '/usr/local/bin/zmx', escape)).toBe(
      " --pty-backend zmx --zmx-path '/usr/local/bin/zmx'"
    )
  })
})
