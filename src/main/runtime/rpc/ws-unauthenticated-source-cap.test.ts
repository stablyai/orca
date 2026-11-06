import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { UnauthenticatedSourceCap } from './ws-unauthenticated-source-cap'

function peer(remoteAddress: string): Socket & EventEmitter {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the cap reads only remoteAddress and close.
  return Object.assign(new EventEmitter(), { remoteAddress }) as unknown as Socket & EventEmitter
}

describe('UnauthenticatedSourceCap', () => {
  it('refuses a source past the cap until one of its sockets closes', () => {
    const log = vi.fn()
    const cap = new UnauthenticatedSourceCap(2, () => 0, log)
    const first = peer('203.0.113.9')
    expect(cap.admit(first)).toBe(true)
    expect(cap.admit(peer('::ffff:203.0.113.9'))).toBe(true)
    expect(cap.admit(peer('203.0.113.9'))).toBe(false)
    expect(cap.admit(peer('203.0.113.9'))).toBe(false)
    expect(cap.admit(peer('203.0.113.10'))).toBe(true)
    expect(log).toHaveBeenCalledOnce()

    first.emit('close')
    expect(cap.admit(peer('203.0.113.9'))).toBe(true)
  })

  it('counts an IPv6 /64 as one source', () => {
    const cap = new UnauthenticatedSourceCap(1, () => 0, vi.fn())
    expect(cap.admit(peer('2001:db8:1:2::1'))).toBe(true)
    expect(cap.admit(peer('2001:db8:1:2::2'))).toBe(false)
    expect(cap.admit(peer('2001:db8:1:3::1'))).toBe(true)
  })

  it('never limits loopback', () => {
    const cap = new UnauthenticatedSourceCap(1, () => 0, vi.fn())
    for (let index = 0; index < 5; index += 1) {
      expect(cap.admit(peer('127.0.0.1'))).toBe(true)
      expect(cap.admit(peer('::1'))).toBe(true)
    }
  })

  it('frees the slot on authentication and admits a source holding an authenticated socket', () => {
    const cap = new UnauthenticatedSourceCap(1, () => 0, vi.fn())
    const client = peer('192.168.1.20')
    expect(cap.admit(client)).toBe(true)
    cap.noteAuthenticated(client)
    expect(cap.admit(peer('192.168.1.20'))).toBe(true)
    // Past the cap, but this source has already proven a credential.
    expect(cap.admit(peer('192.168.1.20'))).toBe(true)

    client.emit('close')
    expect(cap.admit(peer('192.168.1.20'))).toBe(false)
  })
})
