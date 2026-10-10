import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { execute, generations } = vi.hoisted(() => ({
  execute: vi.fn(),
  generations: new Map<string, number>()
}))
vi.mock('../git/runner', () => ({ glabExecFileAsync: execute }))
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProviderGeneration: (id: string) => generations.get(id) ?? 0
}))

import {
  _getKnownHostsCacheSize,
  _resetKnownHostsCache,
  getGlabKnownHosts,
  KNOWN_HOSTS_CACHE_MAX_ENTRIES,
  rememberGlabKnownHosts
} from './gitlab-known-host-probe'
import { NEGATIVE_ENTRY_TTL_MS } from '../git/remote-ref-probe-cache'

beforeEach(() => {
  _resetKnownHostsCache()
  generations.clear()
  execute.mockReset().mockRejectedValue(new Error('keyring locked'))
  vi.spyOn(Date, 'now').mockReturnValue(1_000)
})
afterEach(() => {
  vi.restoreAllMocks()
})

it('coalesces failures and suppresses repeated polls until the retry boundary', async () => {
  await Promise.all(Array.from({ length: 20 }, () => getGlabKnownHosts()))
  for (let index = 0; index < 20; index++) {
    await getGlabKnownHosts()
  }
  expect(execute).toHaveBeenCalledTimes(1)
  vi.mocked(Date.now).mockReturnValue(1_000 + NEGATIVE_ENTRY_TTL_MS - 1)
  await getGlabKnownHosts()
  expect(execute).toHaveBeenCalledTimes(1)
  vi.mocked(Date.now).mockReturnValue(1_000 + NEGATIVE_ENTRY_TTL_MS)
  execute.mockResolvedValueOnce({ stdout: 'Logged in to recovered.test as user', stderr: '' })
  await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com', 'recovered.test'])
  expect(execute).toHaveBeenCalledTimes(2)
})

it('lets an explicit authentication refresh replace the failure fallback immediately', async () => {
  await getGlabKnownHosts()
  rememberGlabKnownHosts(['gitlab.com'])
  vi.mocked(Date.now).mockReturnValue(1_000 + NEGATIVE_ENTRY_TTL_MS)
  await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com'])
  expect(execute).toHaveBeenCalledTimes(1)
  rememberGlabKnownHosts(['self-hosted.test'])
  await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com', 'self-hosted.test'])
})

it('isolates failures by execution context and retires them on reconnect', async () => {
  for (let index = 0; index < 2; index++) {
    await getGlabKnownHosts()
    await getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' })
    await getGlabKnownHosts(undefined, { wslDistro: 'Debian' })
    await getGlabKnownHosts('connection')
  }
  expect(execute).toHaveBeenCalledTimes(4)
  generations.set('connection', 1)
  await getGlabKnownHosts('connection')
  expect(execute).toHaveBeenCalledTimes(5)
})

it('keeps the failure cache bounded', async () => {
  for (let index = 0; index < KNOWN_HOSTS_CACHE_MAX_ENTRIES + 10; index++) {
    await getGlabKnownHosts(`connection-${index}`)
  }
  expect(_getKnownHostsCacheSize()).toBe(KNOWN_HOSTS_CACHE_MAX_ENTRIES)
})

it('does not publish an old failure after an explicit reset', async () => {
  const pending = Promise.withResolvers<{ stdout: string; stderr: string }>()
  execute.mockReturnValueOnce(pending.promise)
  const old = getGlabKnownHosts()
  _resetKnownHostsCache()
  pending.reject(new Error('old failure'))
  await old
  await getGlabKnownHosts()
  expect(execute).toHaveBeenCalledTimes(2)
})
