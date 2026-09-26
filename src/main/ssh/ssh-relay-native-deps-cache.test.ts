// The cache is shared across every relay directory on a host, so these cover the two things that
// make sharing safe: the key changes when the tree's inputs change, and GC refuses to delete on
// anything short of a complete, attributable reference listing.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn()
}))

import { execCommand } from './ssh-relay-deploy-helpers'
import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import {
  computeRelayNativeDepsCacheKey,
  isRelayNativeDepsCacheEntryName,
  relayNativeDepsCacheEntryDir,
  relayNativeDepsCacheNodeModulesPath,
  supportsRelayNativeDepsCache
} from './ssh-relay-native-deps-cache'
import {
  ensureRelayNativeDepsCacheCommand,
  promoteRelayNativeDepsCacheCommand,
  RELAY_NATIVE_CACHE_LIST_OK,
  RELAY_NATIVE_CACHE_REFS_ERR,
  RELAY_NATIVE_CACHE_REFS_OK
} from './ssh-relay-native-deps-cache-commands'
import { gcRelayNativeDepsCache } from './ssh-relay-native-deps-cache-gc'

const POSIX = getRemoteHostPlatform('linux-x64')
const WINDOWS = getRemoteHostPlatform('win32-x64')
const HOME = '/home/u'
const DEPS = { 'node-pty': '1.1.0', '@parcel/watcher': '2.5.6' } as const
const KEY = computeRelayNativeDepsCacheKey({ platform: 'linux-x64', deps: DEPS })
const RELAY_DIR = `${HOME}/.orca-remote/relay-0.1.0+aaa`

const conn = {} as SshConnection
const mockExec = vi.mocked(execCommand)

function refsOk(...targets: string[]): string {
  return [...targets.map((t) => `REF ${t}`), RELAY_NATIVE_CACHE_REFS_OK].join('\n')
}

function listing(...keys: string[]): string {
  return [...keys.map((k) => `ENTRY ${k}`), RELAY_NATIVE_CACHE_LIST_OK].join('\n')
}

describe('computeRelayNativeDepsCacheKey', () => {
  it('keys on the dependency set, not on the relay bundle', () => {
    expect(computeRelayNativeDepsCacheKey({ platform: 'linux-x64', deps: DEPS })).toBe(KEY)
    expect(
      computeRelayNativeDepsCacheKey({
        platform: 'linux-x64',
        deps: { '@parcel/watcher': '2.5.6', 'node-pty': '1.1.0' }
      })
    ).toBe(KEY)
  })

  it('mints a new entry when a dependency version moves', () => {
    expect(
      computeRelayNativeDepsCacheKey({
        platform: 'linux-x64',
        deps: { ...DEPS, 'node-pty': '1.2.0' }
      })
    ).not.toBe(KEY)
  })

  it('mints a new entry when a patch applied to the tree changes', () => {
    const withPatch = computeRelayNativeDepsCacheKey({
      platform: 'linux-x64',
      deps: DEPS,
      patchSources: [{ filename: 'node-pty-1.1.0-patch.cjs', contents: 'a' }]
    })
    const withChangedPatch = computeRelayNativeDepsCacheKey({
      platform: 'linux-x64',
      deps: DEPS,
      patchSources: [{ filename: 'node-pty-1.1.0-patch.cjs', contents: 'b' }]
    })
    expect(withPatch).not.toBe(KEY)
    expect(withChangedPatch).not.toBe(withPatch)
  })

  it('separates platforms so one host never links another architecture', () => {
    expect(computeRelayNativeDepsCacheKey({ platform: 'linux-arm64', deps: DEPS })).not.toBe(KEY)
    expect(KEY.startsWith('linux-x64-')).toBe(true)
  })

  it('refuses a platform it cannot recognise rather than building a path from it', () => {
    expect(() => computeRelayNativeDepsCacheKey({ platform: '../../etc', deps: DEPS })).toThrow(
      /Unsafe relay native-deps cache key/
    )
    expect(isRelayNativeDepsCacheEntryName('../../etc')).toBe(false)
    expect(isRelayNativeDepsCacheEntryName(KEY)).toBe(true)
  })

  it('leaves Windows on the per-directory install', () => {
    expect(supportsRelayNativeDepsCache(POSIX)).toBe(true)
    expect(supportsRelayNativeDepsCache(WINDOWS)).toBe(false)
  })
})

describe('ensureRelayNativeDepsCacheCommand', () => {
  const command = ensureRelayNativeDepsCacheCommand(
    { host: POSIX, remoteHome: HOME, relayDir: RELAY_DIR, key: KEY },
    DEPS
  )

  it('links only an entry that carries the completion sentinel', () => {
    expect(command).toContain(`[ -f "$cache/.deps-complete" ]`)
    expect(command).toContain('ln -s "$target" "$nm"')
    expect(command).toContain(relayNativeDepsCacheNodeModulesPath(POSIX, HOME, KEY))
  })

  it('never overwrites a directory the relay installed for itself', () => {
    // The link is only created on a path that does not exist; a real node_modules reads as a miss.
    expect(command).toContain('if [ ! -e "$nm" ] && ln -s "$target" "$nm"')
  })

  it('seeds only from a sibling whose manifest pins the same versions', () => {
    for (const [name, version] of Object.entries(DEPS)) {
      expect(command).toContain(`grep -F -q '"${name}":"${version}"' "$pj"`)
    }
    expect(command).toContain('[ -d "$cand/node-pty" ] || continue')
  })
})

describe('promoteRelayNativeDepsCacheCommand', () => {
  const command = promoteRelayNativeDepsCacheCommand({
    host: POSIX,
    remoteHome: HOME,
    relayDir: RELAY_DIR,
    key: KEY
  })

  it('elects one publisher with mkdir rather than a lock', () => {
    expect(command).toContain('mkdir "$cache" 2>/dev/null')
  })

  it('writes the completion sentinel after the symlink exists', () => {
    expect(command.indexOf('ln -s "$target" "$nm"')).toBeLessThan(
      command.indexOf(': > "$cache/.deps-complete"')
    )
  })

  it('never deletes the entry unless the tree made it back to the relay directory', () => {
    expect(command).toContain('if mv "$target" "$nm" 2>/dev/null; then rm -rf "$cache"')
  })

  it('refuses to publish a directory that is already a shared symlink', () => {
    expect(command).toContain('if [ -L "$nm" ]; then')
  })
})

describe('gcRelayNativeDepsCache', () => {
  beforeEach(() => {
    mockExec.mockReset().mockResolvedValue('')
  })

  it('removes an entry nothing links to', async () => {
    mockExec
      .mockResolvedValueOnce(listing(KEY))
      .mockResolvedValueOnce(refsOk())
      .mockResolvedValueOnce('MOVED')
      .mockResolvedValueOnce(refsOk())
      .mockResolvedValueOnce('')

    await gcRelayNativeDepsCache(conn, POSIX, HOME)

    const last = mockExec.mock.calls.at(-1)?.[1] ?? ''
    expect(last).toContain('rm -rf')
    expect(last).toContain('.gc-tombstone.')
  })

  it('keeps an entry a live relay depends on', async () => {
    mockExec
      .mockResolvedValueOnce(listing(KEY))
      .mockResolvedValueOnce(refsOk(relayNativeDepsCacheNodeModulesPath(POSIX, HOME, KEY)))

    await gcRelayNativeDepsCache(conn, POSIX, HOME)

    expect(mockExec).toHaveBeenCalledTimes(2)
    expect(mockExec.mock.calls.some(([, c]) => c.startsWith('rm -rf'))).toBe(false)
  })

  it('keeps every entry when the reference listing never answers', async () => {
    mockExec.mockResolvedValueOnce(listing(KEY)).mockResolvedValueOnce('REF /somewhere\n')

    await gcRelayNativeDepsCache(conn, POSIX, HOME)

    expect(mockExec).toHaveBeenCalledTimes(2)
  })

  it('keeps every entry when the reference scan reports an unreadable link', async () => {
    mockExec.mockResolvedValueOnce(listing(KEY)).mockResolvedValueOnce(RELAY_NATIVE_CACHE_REFS_ERR)

    await gcRelayNativeDepsCache(conn, POSIX, HOME)

    expect(mockExec).toHaveBeenCalledTimes(2)
  })

  it('keeps every entry when a reference has a shape this client never writes', async () => {
    // A relative target cannot be attributed to an entry without guessing what it resolves to.
    mockExec
      .mockResolvedValueOnce(listing(KEY))
      .mockResolvedValueOnce(refsOk('../native/x/node_modules'))

    await gcRelayNativeDepsCache(conn, POSIX, HOME)

    expect(mockExec).toHaveBeenCalledTimes(2)
  })

  it('ignores a link that points outside the cache entirely', async () => {
    mockExec
      .mockResolvedValueOnce(listing(KEY))
      .mockResolvedValueOnce(refsOk('/opt/shared/node_modules'))
      .mockResolvedValueOnce('MOVED')
      .mockResolvedValueOnce(refsOk('/opt/shared/node_modules'))
      .mockResolvedValueOnce('')

    await gcRelayNativeDepsCache(conn, POSIX, HOME)

    expect(mockExec.mock.calls.some(([, c]) => c.startsWith('rm -rf'))).toBe(true)
  })

  it('restores the tree when a deploy links the entry after the tombstone rename', async () => {
    mockExec
      .mockResolvedValueOnce(listing(KEY))
      .mockResolvedValueOnce(refsOk())
      .mockResolvedValueOnce('MOVED')
      .mockResolvedValueOnce(refsOk(relayNativeDepsCacheNodeModulesPath(POSIX, HOME, KEY)))
      .mockResolvedValueOnce('MOVED')

    await gcRelayNativeDepsCache(conn, POSIX, HOME)

    const last = mockExec.mock.calls.at(-1)?.[1] ?? ''
    expect(last).toContain('mv ')
    expect(last).toContain(relayNativeDepsCacheEntryDir(POSIX, HOME, KEY))
    expect(mockExec.mock.calls.some(([, c]) => c.startsWith('rm -rf'))).toBe(false)
  })

  it('restores the tree when the recheck itself cannot answer', async () => {
    mockExec
      .mockResolvedValueOnce(listing(KEY))
      .mockResolvedValueOnce(refsOk())
      .mockResolvedValueOnce('MOVED')
      .mockRejectedValueOnce(new Error('channel closed'))
      .mockResolvedValueOnce('MOVED')

    await gcRelayNativeDepsCache(conn, POSIX, HOME)

    expect(mockExec.mock.calls.some(([, c]) => c.startsWith('rm -rf'))).toBe(false)
  })

  it('never removes a pinned key', async () => {
    mockExec.mockResolvedValueOnce(listing(KEY)).mockResolvedValueOnce(refsOk())

    await gcRelayNativeDepsCache(conn, POSIX, HOME, { pinnedKeys: [KEY] })

    expect(mockExec).toHaveBeenCalledTimes(2)
  })

  it('drops a listed name it could not have minted rather than interpolating it', async () => {
    mockExec
      .mockResolvedValueOnce(`ENTRY ../../.ssh\n${RELAY_NATIVE_CACHE_LIST_OK}`)
      .mockResolvedValueOnce(refsOk())

    await gcRelayNativeDepsCache(conn, POSIX, HOME)

    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  it('does nothing on a host that never creates entries', async () => {
    await gcRelayNativeDepsCache(conn, WINDOWS, 'C:\\Users\\u')

    expect(mockExec).not.toHaveBeenCalled()
  })
})
