import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseWslHostsPolicy,
  wslHostsPolicyMovedProjects,
  wslHostsPolicyState
} from '../../shared/wsl-hosts-policy'
import {
  readCachedWslHostsPolicy,
  WslHostsPolicyLiveUpdater,
  wslHostsPolicyCacheFileName,
  wslHostsPolicyChannelForAppVersion,
  wslHostsPolicyDownloadUrl
} from './wsl-hosts-policy-live-update'

const STABLE = '1.4.2'
const RC = '1.4.3-rc.1'

const policy = (revision: number, wslHosts: 'allow' | 'block'): string =>
  JSON.stringify({ version: 1, revision, wslHosts })

describe('WSL hosts policy parsing', () => {
  it('accepts a known policy and ignores fields added later', () => {
    const parsed = parseWslHostsPolicy(
      JSON.stringify({ version: 1, revision: 3, wslHosts: 'block', note: 'later field' })
    )

    expect(parsed).toEqual({ ok: true, policy: { version: 1, revision: 3, wslHosts: 'block' } })
  })

  it.each([
    ['not JSON', '{'],
    ['an unknown format', JSON.stringify({ version: 2, revision: 1, wslHosts: 'block' })],
    ['an unknown switch value', JSON.stringify({ version: 1, revision: 1, wslHosts: 'drain' })],
    ['no revision', JSON.stringify({ version: 1, wslHosts: 'block' })],
    ['an oversized file', `${policy(1, 'block')}${' '.repeat(17 * 1024)}`]
  ])('rejects %s', (_label, text) => {
    expect(parseWslHostsPolicy(text).ok).toBe(false)
  })

  it('reads moved projects as keep unless a block asks for them back', () => {
    const parse = (fields: Record<string, unknown>) => {
      const parsed = parseWslHostsPolicy(JSON.stringify({ version: 1, revision: 1, ...fields }))
      if (!parsed.ok) {
        throw new Error(parsed.error)
      }
      return parsed.policy
    }
    expect(wslHostsPolicyMovedProjects(null)).toBe('keep')
    expect(wslHostsPolicyMovedProjects(parse({ wslHosts: 'block' }))).toBe('keep')
    expect(
      wslHostsPolicyMovedProjects(parse({ wslHosts: 'block', movedProjects: 'bring-back' }))
    ).toBe('bring-back')
    expect(
      wslHostsPolicyMovedProjects(parse({ wslHosts: 'allow', movedProjects: 'bring-back' }))
    ).toBe('keep')
    // A later value must not drop the block it rides on.
    const later = parse({ wslHosts: 'block', movedProjects: 'some-later-mode' })
    expect(wslHostsPolicyState(later)).toBe('block')
    expect(wslHostsPolicyMovedProjects(later)).toBe('keep')
  })

  it('reads no policy as missing, never as a block', () => {
    expect(wslHostsPolicyState(null)).toBe('missing')
    expect(wslHostsPolicyState({ version: 1, revision: 1, wslHosts: 'allow' })).toBe('allow')
    expect(wslHostsPolicyState({ version: 1, revision: 1, wslHosts: 'block' })).toBe('block')
  })
})

describe('WSL hosts policy live update', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-policy-'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  const respond = (body: string, status = 200) => vi.fn(async () => new Response(body, { status }))
  const updater = (
    fetch: (url: string) => Promise<Response>,
    options: { appVersion?: string; isPackaged?: boolean } = {}
  ) =>
    new WslHostsPolicyLiveUpdater({
      userDataPath,
      appVersion: options.appVersion ?? STABLE,
      isPackaged: options.isPackaged ?? true,
      fetch
    })
  const seedCache = (text: string, appVersion = STABLE) => {
    const channel = wslHostsPolicyChannelForAppVersion(appVersion)
    if (!channel) {
      throw new Error(`no channel for ${appVersion}`)
    }
    writeFileSync(join(userDataPath, wslHostsPolicyCacheFileName(channel)), text)
  }

  it('splits stable from prerelease channels', () => {
    expect(wslHostsPolicyChannelForAppVersion(STABLE)).toBe('stable')
    expect(wslHostsPolicyChannelForAppVersion(RC)).toBe('next')
    expect(wslHostsPolicyDownloadUrl('stable')).toMatch(
      /\/releases\/download\/wsl-hosts-policy-stable\/wsl-hosts-policy\.json$/
    )
  })

  it('caches a downloaded block for the next launch', async () => {
    const fetch = respond(policy(1, 'block'))
    const live = updater(fetch)
    await live.start()
    live.stop()

    expect(fetch).toHaveBeenCalledWith(wslHostsPolicyDownloadUrl('stable'), expect.anything())
    expect(readCachedWslHostsPolicy(userDataPath, STABLE)).toEqual({
      version: 1,
      revision: 1,
      wslHosts: 'block'
    })
  })

  // A build that doesn't know a field must not strip it for the newer build sharing the profile.
  it('caches the downloaded text verbatim, fields this build does not know included', async () => {
    const text = JSON.stringify({
      version: 1,
      revision: 3,
      wslHosts: 'block',
      someLaterField: { keep: true }
    })
    const live = updater(respond(text))
    await live.start()
    live.stop()

    const cachedText = readFileSync(
      join(userDataPath, wslHostsPolicyCacheFileName('stable')),
      'utf8'
    )
    expect(cachedText).toBe(text)
    // This build reads its own fields from it, and a newer parser still finds the later one.
    expect(readCachedWslHostsPolicy(userDataPath, STABLE)?.wslHosts).toBe('block')
    expect(JSON.parse(cachedText)).toMatchObject({ someLaterField: { keep: true } })
  })

  it('never lets a lower or equal revision replace the cache', async () => {
    seedCache(policy(5, 'block'))
    const live = updater(respond(policy(5, 'allow')))
    await live.start()
    live.stop()

    expect(readCachedWslHostsPolicy(userDataPath, STABLE)?.wslHosts).toBe('block')
  })

  it('lifts a block with a higher revision', async () => {
    seedCache(policy(5, 'block'))
    const live = updater(respond(policy(6, 'allow')))
    await live.start()
    live.stop()

    expect(readCachedWslHostsPolicy(userDataPath, STABLE)?.wslHosts).toBe('allow')
  })

  it.each([
    ['an unpublished policy', respond('', 404)],
    ['a server error', respond('', 503)],
    ['a malformed download', respond('{"version":1')],
    [
      'a network failure',
      vi.fn(async () => {
        throw new Error('offline')
      })
    ]
  ])('keeps the last good cache after %s', async (_label, fetch) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    seedCache(policy(2, 'block'))
    const live = updater(fetch)
    await live.start()
    live.stop()

    expect(readCachedWslHostsPolicy(userDataPath, STABLE)?.revision).toBe(2)
    expect(readdirSync(userDataPath)).toEqual([wslHostsPolicyCacheFileName('stable')])
  })

  it('never downloads in an unpackaged run', async () => {
    const fetch = respond(policy(1, 'block'))
    await updater(fetch, { isPackaged: false }).start()

    expect(fetch).not.toHaveBeenCalled()
    expect(readCachedWslHostsPolicy(userDataPath, STABLE)).toBeNull()
  })

  it('keeps a prerelease switch out of a stable build sharing the profile', () => {
    seedCache(policy(1, 'block'), RC)

    expect(readCachedWslHostsPolicy(userDataPath, RC)?.wslHosts).toBe('block')
    expect(readCachedWslHostsPolicy(userDataPath, STABLE)).toBeNull()
  })

  it('reads an unreadable cache as no policy', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mkdirSync(join(userDataPath, wslHostsPolicyCacheFileName('stable')))

    expect(readCachedWslHostsPolicy(userDataPath, STABLE)).toBeNull()
  })
})
