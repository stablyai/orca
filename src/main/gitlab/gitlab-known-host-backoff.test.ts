import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('../git/runner', () => ({ glabExecFileAsync: execute }))

import {
  _resetKnownHostsCache,
  getGlabKnownHosts,
  KNOWN_HOSTS_FAILURE_INITIAL_BACKOFF_MS,
  rememberGlabKnownHosts
} from './gitlab-known-host-probe'
import { NEGATIVE_ENTRY_TTL_MS } from '../git/remote-ref-probe-cache'

const RECOVERED = { stdout: 'Logged in to recovered.test as user', stderr: '' }

beforeEach(() => {
  _resetKnownHostsCache()
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
  vi.mocked(Date.now).mockReturnValue(1_000 + KNOWN_HOSTS_FAILURE_INITIAL_BACKOFF_MS - 1)
  await getGlabKnownHosts()
  expect(execute).toHaveBeenCalledTimes(1)
  vi.mocked(Date.now).mockReturnValue(1_000 + KNOWN_HOSTS_FAILURE_INITIAL_BACKOFF_MS)
  execute.mockResolvedValueOnce(RECOVERED)
  await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com', 'recovered.test'])
  expect(execute).toHaveBeenCalledTimes(2)
})

it('doubles the retry delay on repeated failures up to the negative-entry TTL', async () => {
  let now = 1_000
  const retryDelays: number[] = []
  for (let attempt = 0; attempt < 7; attempt++) {
    await getGlabKnownHosts()
    let delay = 0
    while (execute.mock.calls.length === attempt + 1) {
      delay += 1_000
      vi.mocked(Date.now).mockReturnValue(now + delay)
      await getGlabKnownHosts()
    }
    retryDelays.push(delay)
    now += delay
  }
  const initial = KNOWN_HOSTS_FAILURE_INITIAL_BACKOFF_MS
  expect(retryDelays.slice(0, 4)).toEqual([initial, initial * 2, initial * 4, initial * 8])
  expect(retryDelays.at(-1)).toBe(NEGATIVE_ENTRY_TTL_MS)
})

it('lets an authentication refresh retry immediately', async () => {
  await getGlabKnownHosts()
  rememberGlabKnownHosts([])
  execute.mockResolvedValueOnce(RECOVERED)
  await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com', 'recovered.test'])
  expect(execute).toHaveBeenCalledTimes(2)
})

it('lets an explicit reset retry immediately', async () => {
  await getGlabKnownHosts()
  _resetKnownHostsCache()
  await getGlabKnownHosts()
  expect(execute).toHaveBeenCalledTimes(2)
})

it('isolates failures by execution context', async () => {
  for (let index = 0; index < 2; index++) {
    await getGlabKnownHosts()
    await getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' })
    await getGlabKnownHosts(undefined, { wslDistro: 'Debian' })
    await getGlabKnownHosts('connection')
  }
  expect(execute).toHaveBeenCalledTimes(4)
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
