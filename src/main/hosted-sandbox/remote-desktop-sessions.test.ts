import { beforeEach, describe, expect, it } from 'vitest'
import {
  registerRemoteDesktopSession,
  remoteDesktopSessionForUrl,
  resetRemoteDesktopSessionsForTest,
  takeRemoteDesktopTicket
} from './remote-desktop-sessions'

const URL_6081 = 'http://localhost:6081/vnc.html?autoconnect=0&reconnect=0&resize=remote'
const ticket = (n: number): string => String(n).padStart(43, 't')

function register(options: { live?: () => boolean; firstExpiresAt?: number } = {}): void {
  let minted = 0
  registerRemoteDesktopSession(
    {
      environmentId: 'env-1',
      localPort: 6081,
      path: 'vnc.html',
      mint: async () => ({ ok: true, ticket: ticket((minted += 1) + 100), expiresAt: 999_999 }),
      ...(options.live ? { isLive: options.live } : {})
    },
    { ticket: ticket(1), expiresAt: options.firstExpiresAt ?? 100_000 }
  )
}

describe('remote desktop sessions', () => {
  beforeEach(() => resetRemoteDesktopSessionsForTest())

  it('trusts only the exact URL Orca built, on localhost or 127.0.0.1', () => {
    register()
    expect(remoteDesktopSessionForUrl(URL_6081)).not.toBeNull()
    expect(remoteDesktopSessionForUrl(URL_6081.replace('localhost', '127.0.0.1'))).not.toBeNull()
    for (const url of [
      `${URL_6081}&host=evil.example`,
      `${URL_6081}#host=evil.example&encrypt=1`,
      `${URL_6081}&logging=debug`,
      'http://localhost:6081/vnc.html',
      'http://localhost:6081/vnc_lite.html?autoconnect=0&reconnect=0&resize=remote',
      URL_6081.replace('http:', 'https:'),
      URL_6081.replace('localhost', 'localhost.evil.example'),
      URL_6081.replace('6081', '6082'),
      URL_6081.replace('http://', 'http://user:pw@')
    ]) {
      expect(remoteDesktopSessionForUrl(url), url).toBeNull()
    }
  })

  it('forgets a session once its forward is gone', () => {
    let live = true
    register({ live: () => live })
    expect(remoteDesktopSessionForUrl(URL_6081)).not.toBeNull()
    live = false
    expect(remoteDesktopSessionForUrl(URL_6081)).toBeNull()
    live = true
    // Pruned: a later page on that port is not trusted until Orca opens the desktop again.
    expect(remoteDesktopSessionForUrl(URL_6081)).toBeNull()
  })

  it('hands out the open’s ticket once, and never within 5 s of its expiry', async () => {
    register({ firstExpiresAt: 10_000 })
    const session = remoteDesktopSessionForUrl(URL_6081)!
    expect(await takeRemoteDesktopTicket(session, () => 1_000)).toMatchObject({ ticket: ticket(1) })
    expect(await takeRemoteDesktopTicket(session, () => 1_000)).toMatchObject({
      ticket: ticket(101)
    })
    register({ firstExpiresAt: 10_000 })
    const fresh = remoteDesktopSessionForUrl(URL_6081)!
    expect(await takeRemoteDesktopTicket(fresh, () => 6_000)).toMatchObject({ ticket: ticket(101) })
  })
})
