import type * as NodeOs from 'node:os'
import type * as NodePath from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const osMock = vi.hoisted(() => ({
  homedir: () => '/profiles/p1',
  userInfo: (): { homedir: string } => ({ homedir: '/Users/me' })
}))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => osMock.homedir(),
  userInfo: () => osMock.userInfo()
}))
vi.mock('node:path', async (importOriginal) => (await importOriginal<typeof NodePath>()).posix)
import {
  macosProtectedWatchExclusions,
  withMacosProtectedWatchExclusions
} from './macos-protected-watch-exclusions'

// Canonical spellings stand in for realpath: an alias, a case variant and the real home.
const CANONICAL: Record<string, string> = {
  '/Users/me/Library': '/Users/me/Library',
  '/Users/ME/Library': '/Users/me/Library',
  '/var/home-link/Library': '/Users/me/Library',
  '/profiles/p1/Library': '/profiles/p1/Library'
}
const realpath = (candidate: string): string => {
  const resolved = CANONICAL[candidate]
  if (!resolved) {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  return resolved
}
const darwin = { platform: 'darwin' as const, realpath }

describe('macosProtectedWatchExclusions', () => {
  it('excludes the canonical Library of a home or wider root', () => {
    for (const root of ['/Users/me', '/Users', '/']) {
      expect(macosProtectedWatchExclusions(root, { ...darwin, homes: ['/Users/me'] })).toEqual([
        '/Users/me/Library'
      ])
    }
  })

  it("treats a home named like '..profile' as inside its parent", () => {
    expect(
      macosProtectedWatchExclusions('/Users', {
        ...darwin,
        homes: ['/Users/..profile'],
        realpath: (candidate) => candidate
      })
    ).toEqual(['/Users/..profile/Library'])
    expect(
      macosProtectedWatchExclusions('/Users/me/repo', {
        ...darwin,
        homes: ['/Users/me'],
        realpath: (candidate) => candidate
      })
    ).toEqual([])
  })

  it('resolves alias and case-variant homes to the subscribed identity', () => {
    for (const home of ['/var/home-link', '/Users/ME']) {
      expect(macosProtectedWatchExclusions('/Users/me', { ...darwin, homes: [home] })).toEqual([
        '/Users/me/Library'
      ])
    }
  })

  it("covers the account's home when HOME points at a separate profile", () => {
    expect(
      macosProtectedWatchExclusions('/Users/me', {
        ...darwin,
        homes: ['/profiles/p1', '/Users/me']
      })
    ).toEqual(['/Users/me/Library'])
    expect(
      macosProtectedWatchExclusions('/', { ...darwin, homes: ['/profiles/p1', '/Users/me'] })
    ).toEqual(['/profiles/p1/Library', '/Users/me/Library'])
  })

  it("keeps an opened Library but skips other apps' stores", () => {
    expect(
      macosProtectedWatchExclusions('/Users/me/Library', { ...darwin, homes: ['/Users/me'] })
    ).toEqual(['/Users/me/Library/Containers', '/Users/me/Library/Group Containers'])
  })

  it("defaults to HOME and the account's home", () => {
    expect(macosProtectedWatchExclusions('/Users/me', darwin)).toEqual(['/Users/me/Library'])
    osMock.userInfo = () => {
      throw new Error('no passwd entry')
    }
    try {
      expect(macosProtectedWatchExclusions('/Users/me', darwin)).toEqual([])
      expect(macosProtectedWatchExclusions('/profiles', darwin)).toEqual(['/profiles/p1/Library'])
    } finally {
      osMock.userInfo = () => ({ homedir: '/Users/me' })
    }
  })

  it('excludes nothing for ordinary roots, missing homes or other platforms', () => {
    const homes = ['/Users/me']
    for (const root of [
      '/Users/me/Documents/repo',
      '/Users/me/Library/Containers',
      '/Users/me/Library/Application Support/orca',
      '/Users/meow'
    ]) {
      expect(macosProtectedWatchExclusions(root, { ...darwin, homes })).toEqual([])
    }
    expect(macosProtectedWatchExclusions('/', { ...darwin, homes: ['/missing'] })).toEqual([])
    expect(
      macosProtectedWatchExclusions('/Users/me', { platform: 'linux', homes, realpath })
    ).toEqual([])
  })
})

describe('withMacosProtectedWatchExclusions', () => {
  it('leaves shallow subscriptions alone', () => {
    const shallow = { mode: 'shallow' as const, include: ['a'] }
    expect(
      withMacosProtectedWatchExclusions('/Users/me', shallow, { ...darwin, homes: ['/Users/me'] })
    ).toBe(shallow)
  })
})
