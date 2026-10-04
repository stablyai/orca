import { describe, expect, it } from 'vitest'
import { Socket } from 'node:net'
import { isRelaySocketPeerClosed } from './relay-socket-peer-close'

const coded = (code: string): Error => Object.assign(new Error(code), { code })

describe('isRelaySocketPeerClosed', () => {
  it('treats EPIPE and ECONNRESET write failures as the peer leaving', () => {
    expect(isRelaySocketPeerClosed(new Socket(), coded('EPIPE'))).toBe(true)
    expect(isRelaySocketPeerClosed(new Socket(), coded('ECONNRESET'))).toBe(true)
  })

  it('does not treat errors our own teardown can raise as a peer close', () => {
    for (const code of [
      'ECANCELED',
      'ECONNABORTED',
      'ERR_STREAM_DESTROYED',
      'ERR_STREAM_WRITE_AFTER_END'
    ]) {
      expect(isRelaySocketPeerClosed(new Socket(), coded(code))).toBe(false)
    }
    expect(isRelaySocketPeerClosed(new Socket())).toBe(false)
  })

  it('attributes ERR_STREAM_DESTROYED to the peer only when a peer error destroyed the socket', () => {
    const reset = new Socket()
    reset.on('error', () => {})
    reset.destroy(coded('ECONNRESET'))
    expect(isRelaySocketPeerClosed(reset, coded('ERR_STREAM_DESTROYED'))).toBe(true)

    const ours = new Socket()
    ours.destroy()
    expect(isRelaySocketPeerClosed(ours, coded('ERR_STREAM_DESTROYED'))).toBe(false)
  })
})
