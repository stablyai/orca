import { describe, expect, it } from 'vitest'
import { parseSshConnectionDestination } from './ssh-connection-destination'

const destination = {
  version: 1,
  transport: 'ssh2',
  host: 'resolved.example',
  port: 2222,
  username: 'owner',
  hostKeyFingerprint: `SHA256:${Buffer.alloc(32, 255).toString('base64').replace(/=+$/, '')}`,
  proxyRouteDigest: 'a'.repeat(64)
}

describe('parseSshConnectionDestination', () => {
  it('makes an immutable canonical snapshot without normalizing identity', () => {
    const input = { ...destination, host: 'MixedCase.example', ignored: true }
    const saved = parseSshConnectionDestination(input)
    input.host = 'another.example'
    expect(saved).toEqual({ ...destination, host: 'MixedCase.example' })
    expect(Object.isFrozen(saved)).toBe(true)
    expect(parseSshConnectionDestination(JSON.parse(JSON.stringify(saved)))).toEqual(saved)
  })

  it.each([
    { version: 2 },
    { transport: 'system-ssh' },
    { host: '' },
    { host: 'host\nother' },
    { host: 'h'.repeat(8193) },
    { username: '' },
    { username: 'user\0name' },
    { username: 3 },
    { port: 0 },
    { port: 65536 },
    { port: 22.5 },
    { port: '22' },
    { port: Number.NaN },
    { hostKeyFingerprint: 'SHA256:short' },
    { hostKeyFingerprint: `SHA256:${'A'.repeat(43)}=` },
    { hostKeyFingerprint: `SHA256:${'A'.repeat(42)}B` },
    { proxyRouteDigest: 'A'.repeat(64) },
    { proxyRouteDigest: 'a'.repeat(63) },
    { proxyRouteDigest: undefined }
  ])('refuses malformed binding %j', (change) => {
    expect(() => parseSshConnectionDestination({ ...destination, ...change })).toThrow(
      'ssh_connection_destination_invalid'
    )
  })

  it.each([null, undefined, [], 'host', 1])('refuses nonrecords %j', (value) => {
    expect(() => parseSshConnectionDestination(value)).toThrow('ssh_connection_destination_invalid')
  })

  it.each([1, 65535])('accepts port boundary %i', (port) => {
    expect(parseSshConnectionDestination({ ...destination, port }).port).toBe(port)
  })
})
