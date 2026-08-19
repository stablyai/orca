import type { Cookie } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  removeTransplantableCookies,
  type CookieClearIdentity,
  type CookieClearSession
} from './browser-cookie-import-clear'

/**
 * A jar that actually holds cookies.
 *
 * Why this file exists: every end-to-end fixture in this module starts with `cookies.get` returning
 * `[]`. Against an empty jar, "clear then write all" and "clear then write some" produce the same
 * final state, so the STA-4300 P0 — clearing a populated jar and writing back a strict subset —
 * was invisible to four independent gates. These tests start populated on purpose.
 */
function jar(initial: Cookie[]) {
  let cookies = [...initial]
  const clearDataMock = vi.fn(async () => {
    // Why: the real bulk clear removes everything it is not told to exclude.
    cookies = []
  })
  const removeMock = vi.fn(async (url: string, name: string) => {
    const host = new URL(url).hostname
    cookies = cookies.filter(
      (c) => !(c.name === name && (c.domain ?? '').replace(/^\./, '') === host.replace(/^\./, ''))
    )
  })
  const session: CookieClearSession = {
    cookies: {
      get: async () => [...cookies],
      remove: removeMock
    },
    clearData: clearDataMock,
    snapshotClearIdentities: async (items) =>
      items.map(({ cookie, url }) => ({
        url,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path
      })) as CookieClearIdentity[],
    restoreClearIdentities: async () => undefined
  } as unknown as CookieClearSession
  return {
    session,
    clearDataMock,
    removeMock,
    names: () => cookies.map((c) => c.name).sort(),
    get: (name: string) => cookies.find((c) => c.name === name)
  }
}

const cookie = (domain: string, name: string, value = `${name}-live`): Cookie =>
  ({ domain, name, value, path: '/', secure: true }) as Cookie

describe('removeTransplantableCookies — preserved families on a POPULATED jar', () => {
  it('clears everything when nothing is preserved (unchanged behaviour)', async () => {
    const target = jar([
      cookie('.mixed.example', 'live-session'),
      cookie('.other.example', 'stale')
    ])

    await removeTransplantableCookies(target.session)

    expect(target.names()).toEqual([])
    // Why: the ordinary import must keep using the single bulk call.
    expect(target.clearDataMock).toHaveBeenCalledOnce()
  })

  it('leaves a preserved family untouched while clearing everything else', async () => {
    const target = jar([
      cookie('.mixed.example', 'apex-session'),
      cookie('sub.mixed.example', 'sub-session'),
      cookie('.other.example', 'stale')
    ])

    await removeTransplantableCookies(target.session, new Set(['mixed.example']))

    // The whole family survives — apex AND subdomain — and it survives byte-identically.
    expect(target.names()).toEqual(['apex-session', 'sub-session'])
    expect(target.get('apex-session')?.value).toBe('apex-session-live')
    expect(target.get('sub-session')?.value).toBe('sub-session-live')
  })

  it('never calls bulk clearData when a family is preserved', async () => {
    // Why (§4.3a): clearData removes everything outside excludeOrigins and its own contract admits
    // a rejection may already have emptied part of the jar. A preserved family is deliberately
    // absent from the snapshot, so a partial delete then a rejection would destroy it with nothing
    // able to restore it. The only safe answer is not to call it.
    const target = jar([
      cookie('.mixed.example', 'live-session'),
      cookie('.other.example', 'stale')
    ])

    await removeTransplantableCookies(target.session, new Set(['mixed.example']))

    expect(target.clearDataMock).not.toHaveBeenCalled()
    expect(target.removeMock).toHaveBeenCalled()
  })

  it('never submits a preserved coordinate to a removal', async () => {
    const target = jar([
      cookie('.mixed.example', 'apex-session'),
      cookie('sub.mixed.example', 'sub-session'),
      cookie('.other.example', 'stale')
    ])

    await removeTransplantableCookies(target.session, new Set(['mixed.example']))

    const removedNames = target.removeMock.mock.calls.map((call) => call[1])
    expect(removedNames).toEqual(['stale'])
  })

  it('never submits a preserved coordinate to the restore set either', async () => {
    // Why: the CDP snapshot is taken FROM the removal plan, so filtering the plan filters the
    // restore set with it. That is what keeps a preserved cookie out of every mutation — including
    // the unconditional Network.setCookie that rollback performs.
    const snapshotted: string[] = []
    const target = jar([
      cookie('.mixed.example', 'live-session'),
      cookie('.other.example', 'stale')
    ])
    const session = {
      ...target.session,
      snapshotClearIdentities: async (items: { cookie: Cookie; url: string }[]) => {
        snapshotted.push(...items.map((i) => i.cookie.name))
        return items.map(({ cookie: c, url }) => ({
          url,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path
        })) as CookieClearIdentity[]
      }
    } as unknown as CookieClearSession

    await removeTransplantableCookies(session, new Set(['mixed.example']))

    expect(snapshotted).toEqual(['stale'])
  })

  it('preserves a family named by an IPv4 literal', async () => {
    // Why: psl reads 127.0.0.1 as the dotted DNS name '0.1'. If registrableFamily returned that,
    // the live 127.0.0.1 session would not match the preserve set and would be erased.
    const target = jar([cookie('127.0.0.1', 'loopback-session'), cookie('.other.example', 'stale')])

    await removeTransplantableCookies(target.session, new Set(['127.0.0.1']))

    expect(target.names()).toEqual(['loopback-session'])
  })

  it('preserves a single-label host family', async () => {
    const target = jar([cookie('localhost', 'dev-session'), cookie('.other.example', 'stale')])

    await removeTransplantableCookies(target.session, new Set(['localhost']))

    expect(target.names()).toEqual(['dev-session'])
  })

  it('does not preserve a different family that merely shares a suffix', async () => {
    const target = jar([cookie('.kept.example', 'kept'), cookie('.other.example', 'stale')])

    await removeTransplantableCookies(target.session, new Set(['kept.example']))

    expect(target.names()).toEqual(['kept'])
  })

  it('keeps skip-path removals at concurrency eight', async () => {
    let releaseRemovals: (() => void) | undefined
    const removalsReleased = new Promise<void>((resolve) => {
      releaseRemovals = resolve
    })
    let active = 0
    let maxActive = 0
    const remove = vi.fn(async (_url: string, _name: string) => {
      active++
      maxActive = Math.max(maxActive, active)
      await removalsReleased
      active--
    })
    const cookies = [
      cookie('.preserved.example', 'live-session'),
      ...Array.from({ length: 12 }, (_, index) => cookie('.other.example', `stale-${index}`))
    ]
    const clearData = vi.fn()
    const session = {
      cookies: { get: async () => cookies, remove },
      clearData,
      snapshotClearIdentities: async (items: { cookie: Cookie; url: string }[]) =>
        items.map(({ cookie: entry, url }) => ({ url, ...entry })),
      restoreClearIdentities: async () => undefined
    } as unknown as CookieClearSession

    const clearing = removeTransplantableCookies(session, new Set(['preserved.example']))
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(8))
    expect(maxActive).toBe(8)
    expect(clearData).not.toHaveBeenCalled()
    releaseRemovals?.()
    await clearing

    expect(remove).toHaveBeenCalledTimes(12)
    expect(remove.mock.calls.map(([, name]) => name)).not.toContain('live-session')
  })
})
