import { describe, expect, it } from 'vitest'
import { deriveHostFingerprint } from '../notifications/payload-identity/push-host-fingerprint'
import { hostSessionLinkRouteData, parseHostSessionLink } from './host-session-link'

const HOST_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index)))
const OTHER_KEY = btoa(
  String.fromCharCode(...Array.from({ length: 32 }, (_, index) => 255 - index))
)

describe('host session link', () => {
  it('opens the session on the host whose key the link names', () => {
    const fingerprint = deriveHostFingerprint(HOST_KEY)!
    const link = parseHostSessionLink(
      `orca://session?host=${fingerprint}&worktree=${encodeURIComponent('repo::/a b')}&paneKey=tab%3A1`
    )
    const hosts = [
      { id: 'host-other', publicKeyB64: OTHER_KEY },
      { id: 'host-1', publicKeyB64: HOST_KEY }
    ]
    expect(link && hostSessionLinkRouteData(link, hosts)).toEqual({
      hostId: 'host-1',
      worktreeId: 'repo::/a b',
      paneKey: 'tab:1'
    })
    expect(link && hostSessionLinkRouteData(link, [hosts[0]!])).toBeNull()
  })

  it('rejects links that do not name a host fingerprint and worktree', () => {
    const fingerprint = deriveHostFingerprint(HOST_KEY)!
    for (const url of [
      `orca://session?worktree=w`,
      `orca://session?host=${fingerprint}`,
      `orca://session?host=short&worktree=w`,
      `orca://session/extra?host=${fingerprint}&worktree=w`,
      `orca://bot?host=${fingerprint}&worktree=w`,
      `https://session?host=${fingerprint}&worktree=w`,
      `orca://session?host=${fingerprint}&worktree=w&paneKey=`
    ]) {
      expect(parseHostSessionLink(url)).toBeNull()
    }
  })
})
