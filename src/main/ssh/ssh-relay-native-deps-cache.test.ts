import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn()
}))

import { execCommand } from './ssh-relay-deploy-helpers'
import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import {
  isRelayNativeDepsCacheEntryName,
  relayNativeDepsCacheEntryDir,
  relayNativeDepsCacheNodeModulesPath,
  supportsRelayNativeDepsCache
} from './ssh-relay-native-deps-cache'
import {
  RELAY_NATIVE_CACHE_LIST_OK,
  RELAY_NATIVE_CACHE_REFS_ERR,
  RELAY_NATIVE_CACHE_REFS_OK
} from './ssh-relay-native-deps-cache-commands'
import { gcRelayNativeDepsCache } from './ssh-relay-native-deps-cache-gc'

const POSIX = getRemoteHostPlatform('linux-x64')
const WINDOWS = getRemoteHostPlatform('win32-x64')
const HOME = '/home/u'
const KEY = 'linux-x64-99355f00e9e557a3'

const conn = {} as SshConnection
const mockExec = vi.mocked(execCommand)

function refsOk(...targets: string[]): string {
  return [...targets.map((t) => `REF ${t}`), RELAY_NATIVE_CACHE_REFS_OK].join('\n')
}

function listing(...keys: string[]): string {
  return [...keys.map((k) => `ENTRY ${k}`), RELAY_NATIVE_CACHE_LIST_OK].join('\n')
}

describe('historical native cache identities', () => {
  it('recognizes old keys and rejects unsafe directory names', () => {
    expect(isRelayNativeDepsCacheEntryName(KEY)).toBe(true)
    expect(isRelayNativeDepsCacheEntryName('../../etc')).toBe(false)
    expect(() => relayNativeDepsCacheEntryDir(POSIX, HOME, '../../etc')).toThrow(
      /Unsafe relay native-deps cache key/
    )
  })

  it('preserves the POSIX-only cache boundary', () => {
    expect(supportsRelayNativeDepsCache(POSIX)).toBe(true)
    expect(supportsRelayNativeDepsCache(WINDOWS)).toBe(false)
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
    expect(last).toContain('.native-gc-')
  })

  it('keeps an entry a live relay depends on', async () => {
    mockExec
      .mockResolvedValueOnce(listing(KEY))
      .mockResolvedValueOnce(refsOk(relayNativeDepsCacheNodeModulesPath(POSIX, HOME, KEY)))

    await gcRelayNativeDepsCache(conn, POSIX, HOME)

    expect(mockExec).toHaveBeenCalledTimes(2)
    expect(mockExec.mock.calls.some(([, c]) => c.includes('rm -rf'))).toBe(false)
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

    expect(mockExec.mock.calls.some(([, c]) => c.includes('rm -rf'))).toBe(true)
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
    expect(mockExec.mock.calls.some(([, c]) => c.includes('rm -rf'))).toBe(false)
  })

  it('restores the tree when the recheck itself cannot answer', async () => {
    mockExec
      .mockResolvedValueOnce(listing(KEY))
      .mockResolvedValueOnce(refsOk())
      .mockResolvedValueOnce('MOVED')
      .mockRejectedValueOnce(new Error('channel closed'))
      .mockResolvedValueOnce('MOVED')

    await gcRelayNativeDepsCache(conn, POSIX, HOME)

    expect(mockExec.mock.calls.some(([, c]) => c.includes('rm -rf'))).toBe(false)
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
