import { describe, expect, it } from 'vitest'
import { describeSshConnectFailure, isTailnetAddress } from './ssh-connect-failure-description'

function codedError(message: string, code?: string): Error {
  return Object.assign(new Error(message), code ? { code } : {})
}

const LAN = { host: '192.168.1.20', port: 22 }
const TAILNET = { host: '100.71.10.60', port: 22 }

describe('isTailnetAddress', () => {
  it('recognises the carrier-grade NAT range Tailscale assigns from', () => {
    expect(isTailnetAddress('100.64.0.1')).toBe(true)
    expect(isTailnetAddress('100.71.10.60')).toBe(true)
    expect(isTailnetAddress('100.127.255.254')).toBe(true)
  })

  it('does not flag neighbouring 100.x space or private ranges', () => {
    expect(isTailnetAddress('100.63.255.255')).toBe(false)
    expect(isTailnetAddress('100.128.0.1')).toBe(false)
    expect(isTailnetAddress('10.0.0.5')).toBe(false)
    expect(isTailnetAddress('192.168.1.20')).toBe(false)
  })

  it('recognises MagicDNS names', () => {
    expect(isTailnetAddress('mini.tailc9cd08.ts.net')).toBe(true)
    expect(isTailnetAddress('Mini.TailC9CD08.TS.NET.')).toBe(true)
    expect(isTailnetAddress('mini.local')).toBe(false)
  })
})

describe('describeSshConnectFailure', () => {
  it('names the dialed endpoint for an ssh2 timeout', () => {
    const text = describeSshConnectFailure(
      codedError('connect ETIMEDOUT 192.168.1.20:22', 'ETIMEDOUT'),
      LAN
    )
    expect(text).toMatch(/^192\.168\.1\.20:22 did not answer \(timed out\)/)
    expect(text).toContain('VPN')
    expect(text).not.toContain('Tailscale')
  })

  it('points at Tailscale when the timed-out host is a tailnet address', () => {
    const text = describeSshConnectFailure(
      codedError('connect ETIMEDOUT 100.71.10.60:22', 'ETIMEDOUT'),
      TAILNET
    )
    expect(text).toContain('100.71.10.60 is a Tailscale address')
    expect(text).toContain('check that Tailscale is running')
  })

  // The system OpenSSH transport has no errno to offer, only its stderr line.
  it('classifies OpenSSH prose without an error code', () => {
    expect(
      describeSshConnectFailure(
        new Error('ssh: connect to host 100.71.10.60 port 22: Operation timed out'),
        TAILNET
      )
    ).toMatch(/did not answer/)
    expect(
      describeSshConnectFailure(
        new Error('ssh: connect to host 192.168.1.20 port 22: Connection refused'),
        LAN
      )
    ).toMatch(/refused the connection/)
    expect(
      describeSshConnectFailure(new Error('ssh: Could not resolve hostname devbox'), {
        host: 'devbox',
        port: 22
      })
    ).toMatch(/^Could not resolve devbox\./)
  })

  it('separates refused from unreachable so the remedy differs', () => {
    expect(
      describeSshConnectFailure(codedError('connect ECONNREFUSED', 'ECONNREFUSED'), LAN)
    ).toContain('nothing is listening on port 22')
    expect(
      describeSshConnectFailure(codedError('connect EHOSTUNREACH', 'EHOSTUNREACH'), LAN)
    ).toMatch(/^No route to 192\.168\.1\.20/)
  })

  it('tells a MagicDNS lookup failure apart from ordinary DNS trouble', () => {
    const name = { host: 'mini.tailc9cd08.ts.net', port: 22 }
    expect(
      describeSshConnectFailure(codedError('getaddrinfo ENOTFOUND', 'ENOTFOUND'), name)
    ).toContain('MagicDNS')
    expect(
      describeSshConnectFailure(codedError('getaddrinfo ENOTFOUND', 'ENOTFOUND'), {
        host: 'devbox.example',
        port: 22
      })
    ).toContain("this machine's DNS")
  })

  it('passes anything it cannot classify through untouched', () => {
    const message = 'Handshake failed: no matching key exchange algorithm'
    expect(describeSshConnectFailure(new Error(message), LAN)).toBe(message)
  })
})
