import { describe, expect, it } from 'vitest'
import { RuntimeTerminalViewSubscribers } from './runtime-terminal-view-subscribers'

function subscribers(): RuntimeTerminalViewSubscribers {
  return new RuntimeTerminalViewSubscribers({
    notifyPresenceChanged: () => {},
    hasMobileSubscribers: () => false,
    ensureProviderAttach: () => {}
  })
}

describe('host respawn viewer gate', () => {
  it('holds a pane while a client that cannot follow a respawn views it', () => {
    const views = subscribers()
    const releaseNew = views.registerRemote('pty-1', undefined, undefined, true)
    expect(views.everyRemoteViewFollowsHostRespawn('pty-1')).toBe(true)

    const releaseOld = views.registerRemote('pty-1')
    expect(views.everyRemoteViewFollowsHostRespawn('pty-1')).toBe(false)

    releaseOld()
    releaseOld()
    expect(views.everyRemoteViewFollowsHostRespawn('pty-1')).toBe(true)
    releaseNew()
    expect(views.everyRemoteViewFollowsHostRespawn('pty-1')).toBe(true)
  })

  it('ignores a release from before the PTY id was cleared', () => {
    const views = subscribers()
    const releaseStale = views.registerRemote('pty-1')
    views.clearSubscribers('pty-1')
    views.registerRemote('pty-1')

    releaseStale()
    expect(views.everyRemoteViewFollowsHostRespawn('pty-1')).toBe(false)
  })
})
