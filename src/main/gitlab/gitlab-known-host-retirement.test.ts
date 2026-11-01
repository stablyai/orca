import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('../git/runner', () => ({ glabExecFileAsync: execute }))

import { _resetKnownHostsCache, getGlabKnownHosts } from './gitlab-known-host-probe'
import { PROBE_COALESCE_STALE_MS } from '../git/coalesced-probe'

const response = (host: string) => ({ stdout: `Logged in to ${host} as user`, stderr: '' })
const deferred = () => Promise.withResolvers<ReturnType<typeof response>>()

beforeEach(() => {
  _resetKnownHostsCache()
  execute.mockReset()
})
afterEach(() => {
  _resetKnownHostsCache()
  vi.restoreAllMocks()
})

it('does not repopulate an explicitly reset cache from an earlier probe', async () => {
  const old = deferred()
  execute.mockReturnValueOnce(old.promise)
  const oldResult = getGlabKnownHosts()
  _resetKnownHostsCache()
  old.resolve(response('before-reset.test'))
  await expect(oldResult).resolves.toEqual(['gitlab.com', 'before-reset.test'])
  execute.mockResolvedValueOnce(response('after-reset.test'))
  await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com', 'after-reset.test'])
  expect(execute).toHaveBeenCalledTimes(2)
})

it('keeps a post-reset successor joinable when the old probe settles first', async () => {
  const old = deferred()
  const next = deferred()
  execute.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
  const oldResult = getGlabKnownHosts()
  _resetKnownHostsCache()
  const nextResult = getGlabKnownHosts()
  old.resolve(response('before-reset.test'))
  await oldResult
  let joinedSettled = false
  const joined = getGlabKnownHosts().then((hosts) => {
    joinedSettled = true
    return hosts
  })
  await Promise.resolve()
  expect(joinedSettled).toBe(false)
  next.resolve(response('after-reset.test'))
  await expect(nextResult).resolves.toEqual(['gitlab.com', 'after-reset.test'])
  await expect(joined).resolves.toEqual(['gitlab.com', 'after-reset.test'])
  expect(execute).toHaveBeenCalledTimes(2)
})

it('prevents an abandoned same-generation probe from publishing over its successor', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  const old = deferred()
  execute.mockReturnValueOnce(old.promise)
  const oldResult = getGlabKnownHosts('connection')
  clock.mockReturnValue(1000 + PROBE_COALESCE_STALE_MS + 1)
  execute.mockResolvedValueOnce(response('replacement.test'))
  await expect(getGlabKnownHosts('connection')).resolves.toEqual(['gitlab.com', 'replacement.test'])
  old.resolve(response('abandoned.test'))
  await oldResult
  await expect(getGlabKnownHosts('connection')).resolves.toEqual(['gitlab.com', 'replacement.test'])
  expect(execute).toHaveBeenCalledTimes(2)
})
