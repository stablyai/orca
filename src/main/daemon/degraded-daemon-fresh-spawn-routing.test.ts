import { describe, expect, it, vi } from 'vitest'
import {
  DEGRADED_DAEMON_RECOVERY_RETRY_MS,
  DegradedDaemonFreshSpawnRouter
} from './degraded-daemon-fresh-spawn-routing'
import type { IPtyProvider, PtySpawnResult } from '../providers/types'
import { DaemonProtocolError } from './daemon-errors'

function provider(id: string, spawn?: IPtyProvider['spawn']): IPtyProvider {
  return {
    spawn: spawn ?? vi.fn(async () => ({ id: `${id}-pty` }) as PtySpawnResult)
  } as unknown as IPtyProvider
}

function router(opts: {
  probe?: (() => Promise<boolean>) | null
  currentSpawn?: IPtyProvider['spawn']
}) {
  const current = provider('current', opts.currentSpawn)
  const fallback = provider('fallback')
  const sessionProviders = new Map<string, IPtyProvider>()
  return {
    current,
    fallback,
    sessionProviders,
    router: new DegradedDaemonFreshSpawnRouter(
      current,
      fallback,
      sessionProviders,
      opts.probe === undefined ? async () => true : opts.probe
    )
  }
}

describe('DegradedDaemonFreshSpawnRouter', () => {
  it('starts on the fallback, so a held daemon never receives a fresh spawn', () => {
    expect(router({}).router.routesToFallback).toBe(true)
  })

  it('promotes fresh spawns back to the daemon once it answers a health check', async () => {
    const { router: r } = router({ probe: async () => true })

    await expect(r.recover()).resolves.toBe(true)
    expect(r.routesToFallback).toBeUndefined()
  })

  it('stays on the fallback while the daemon is still unhealthy', async () => {
    const { router: r } = router({ probe: async () => false })

    await expect(r.recover()).resolves.toBe(false)
    expect(r.routesToFallback).toBe(true)
  })

  it('routes back to the fallback when a spawn fails after recovery', async () => {
    // The defect: recovery was a one-way flip on a two-way condition. A daemon that answers one
    // health check and wedges again kept every later fresh spawn pointed at it, and each one
    // costs a hello timeout plus a full launcher re-classification — per terminal, for the rest
    // of the session.
    const wedged = vi.fn(async () => {
      throw new DaemonProtocolError('Hello response timed out')
    })
    const { router: r } = router({ probe: async () => true, currentSpawn: wedged })

    await r.recover()
    expect(r.routesToFallback).toBeUndefined()

    await expect(r.spawn({ cwd: '/tmp' } as never)).rejects.toThrow('Hello response timed out')
    expect(r.routesToFallback).toBe(true)
  })

  it('does not immediately re-promote after routing back', async () => {
    // Without re-arming the cooldown the next spawn probes again straight away, and a wedged
    // daemon that still passes a cheap health check would be re-promoted into the same failure.
    const wedged = vi.fn(async () => {
      throw new DaemonProtocolError('Hello response timed out')
    })
    const { router: r } = router({ probe: async () => true, currentSpawn: wedged })

    await r.recover()
    await expect(r.spawn({ cwd: '/tmp' } as never)).rejects.toThrow()

    await expect(r.recover()).resolves.toBe(false)
    expect(r.routesToFallback).toBe(true)

    const past = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + DEGRADED_DAEMON_RECOVERY_RETRY_MS + 1)
    try {
      await expect(r.recover()).resolves.toBe(true)
    } finally {
      past.mockRestore()
    }
  })

  it('never lets a retry of a named session be answered by the fallback', async () => {
    // The dangerous case `!mapped` could not see: a spawn that names a session may already have
    // created it on the daemon and then lost the reply. Demoting on that failure would send the
    // retry to the fallback, which answers with a fresh local shell under the same id while the
    // agent keeps running on the daemon — the pane binds to the shell and the agent is orphaned.
    // That is the symptom this whole change exists to prevent, arriving by another door.
    const lostReply = vi.fn(async () => {
      throw new DaemonProtocolError('Request createSession timed out after 30000ms')
    })
    const {
      router: r,
      current,
      sessionProviders
    } = router({
      probe: async () => true,
      currentSpawn: lostReply
    })

    await r.recover()
    await expect(r.spawn({ cwd: '/tmp', sessionId: 'wt-1@@pane-1' } as never)).rejects.toThrow()

    // The identity sticks to the provider that may already own it...
    expect(sessionProviders.get('wt-1@@pane-1')).toBe(current)
    // ...and keeps routing there even though the shared route has since demoted, which is the
    // property that actually prevents the shadow: the pin outranks the route.
    expect(r.routesToFallback).toBe(true)
    await expect(r.spawn({ cwd: '/tmp', sessionId: 'wt-1@@pane-1' } as never)).rejects.toThrow(
      'Request createSession timed out after 30000ms'
    )
    expect(lostReply).toHaveBeenCalledTimes(2)
  })

  it('demotes for a production-shaped fresh spawn, which always carries an id', async () => {
    // The regression this pins: gating demotion on the ABSENCE of a sessionId made it
    // unreachable outside tests, because every production fresh spawn mints an id before
    // reaching the provider (ipc/pty.ts sets spawnOptions.sessionId). A recovered-then-wedged
    // daemon would keep every later terminal pointed at itself, each paying a hello timeout
    // plus a full launcher re-classification, and each failing anyway.
    const wedged = vi.fn(async () => {
      throw new DaemonProtocolError('Hello response timed out')
    })
    const { router: r, sessionProviders } = router({
      probe: async () => true,
      currentSpawn: wedged
    })

    await r.recover()
    expect(r.routesToFallback).toBeUndefined()

    // Exactly what ipc/pty.ts sends for a new terminal: a minted id, and no attachOnly.
    await expect(r.spawn({ cwd: '/tmp', sessionId: 'wt-1@@pane-9' } as never)).rejects.toThrow(
      'Hello response timed out'
    )

    expect(r.routesToFallback).toBe(true)
    // And correctly does NOT pin: a hello that never completed cannot have created a session,
    // so there is nothing on the daemon for a retry to collide with. Pinning here would strand
    // later attempts on a host holding nothing of theirs.
    expect(sessionProviders.has('wt-1@@pane-9')).toBe(false)
  })

  it('does not demote for an attach that names a session', async () => {
    // An attachOnly spawn is not a fresh terminal; its failure says nothing about whether the
    // next new terminal should go local, and attaches with an id are routed elsewhere anyway.
    const wedged = vi.fn(async () => {
      throw new DaemonProtocolError('Hello response timed out')
    })
    const { router: r } = router({ probe: async () => true, currentSpawn: wedged })

    await r.recover()
    await expect(
      r.spawn({ cwd: '/tmp', sessionId: 'wt-1@@pane-9', attachOnly: true } as never)
    ).rejects.toThrow()

    expect(r.routesToFallback).toBeUndefined()
  })

  it('does not demote when the failure says nothing about the daemon', async () => {
    // A spawn can fail for reasons that are the caller's, not the host's — an unusable cwd, a
    // bad profile. Degrading the whole session's persistence for one of those costs the user
    // daemon-backed terminals the daemon would have served perfectly well.
    const rejected = vi.fn(async () => {
      throw new Error('chdir failed: ENOENT /gone')
    })
    const { router: r } = router({ probe: async () => true, currentSpawn: rejected })

    await r.recover()
    await expect(r.spawn({ cwd: '/gone' } as never)).rejects.toThrow('chdir failed')
    expect(r.routesToFallback).toBeUndefined()
  })

  it('does not pin a session the daemon cannot have created', async () => {
    // The pin exists for a request that was sent and whose answer was lost. A failure that never
    // reached the daemon created nothing, so pinning it would strand later attempts on a host
    // that has nothing of theirs.
    const rejected = vi.fn(async () => {
      throw new Error('chdir failed: ENOENT /gone')
    })
    const { router: r, sessionProviders } = router({
      probe: async () => true,
      currentSpawn: rejected
    })

    await r.recover()
    await expect(r.spawn({ cwd: '/gone', sessionId: 'wt-1@@pane-3' } as never)).rejects.toThrow()
    expect(sessionProviders.has('wt-1@@pane-3')).toBe(false)
  })

  it('still demotes on an anonymous spawn, which cannot be shadowed', async () => {
    // The case demotion exists for: no session identity, so there is nothing a fallback answer
    // could shadow, and paying a hello timeout plus a re-classification per terminal is pure loss.
    const wedged = vi.fn(async () => {
      throw new DaemonProtocolError('Hello response timed out')
    })
    const { router: r } = router({ probe: async () => true, currentSpawn: wedged })

    await r.recover()
    await expect(r.spawn({ cwd: '/tmp' } as never)).rejects.toThrow()
    expect(r.routesToFallback).toBe(true)
  })

  it('keeps a mapped session on its owner while sparing the next terminal', async () => {
    // A mapped id names the provider that actually owns that pty, so it must keep routing there
    // however the shared route moves. But its failure is still evidence the daemon is failing,
    // and the next *fresh* terminal is a different session that cannot be shadowed by this one —
    // so it should not have to discover the same timeout for itself.
    const wedged = vi.fn(async () => {
      throw new DaemonProtocolError('Hello response timed out')
    })
    const {
      router: r,
      current,
      sessionProviders
    } = router({
      probe: async () => true,
      currentSpawn: wedged
    })
    sessionProviders.set('session-1', current)
    // Promote first, or the assertion below passes on the constructor's default and proves nothing.
    await r.recover()
    expect(r.routesToFallback).toBeUndefined()

    await expect(r.spawn({ cwd: '/tmp', sessionId: 'session-1' } as never)).rejects.toThrow()
    expect(sessionProviders.get('session-1')).toBe(current)
    expect(r.routesToFallback).toBe(true)
  })
})
