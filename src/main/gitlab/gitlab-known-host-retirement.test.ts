import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { execute, generations } = vi.hoisted(() => ({
  execute: vi.fn(),
  generations: new Map<string, number>()
}))
vi.mock('../git/runner', () => ({ glabExecFileAsync: execute }))
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProviderGeneration: (connectionId: string) => generations.get(connectionId) ?? 0
}))

import {
  _resetKnownHostsCache,
  getGlabKnownHosts,
  rememberGlabKnownHost
} from './gitlab-known-host-probe'
import { PROBE_COALESCE_STALE_MS } from '../git/coalesced-probe'

const response = (host: string) => ({ stdout: `Logged in to ${host} as user`, stderr: '' })
const deferred = () => Promise.withResolvers<ReturnType<typeof response>>()

async function collect(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the repository Vitest --expose-gc config')
  }
  for (let index = 0; index < 6; index++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function weakResult(connectionId: string): Promise<WeakRef<readonly string[]>> {
  return new WeakRef(await getGlabKnownHosts(connectionId))
}

beforeEach(() => {
  _resetKnownHostsCache()
  generations.clear()
  execute.mockReset()
})
afterEach(() => {
  _resetKnownHostsCache()
  vi.restoreAllMocks()
})

it('releases successful host arrays from superseded SSH generations', async () => {
  const results: WeakRef<readonly string[]>[] = []
  for (let generation = 1; generation <= 32; generation++) {
    generations.set('connection', generation)
    execute.mockResolvedValue(response(`host${generation}.test`))
    results.push(await weakResult('connection'))
  }
  await collect()
  expect(results.filter((result) => result.deref() !== undefined)).toHaveLength(1)
  await expect(getGlabKnownHosts('connection')).resolves.toEqual(['gitlab.com', 'host32.test'])
  expect(execute).toHaveBeenCalledTimes(32)
})

it('retires remembered generations without requiring an auth-status probe', async () => {
  const results: WeakRef<readonly string[]>[] = []
  for (let generation = 1; generation <= 16; generation++) {
    generations.set('connection', generation)
    rememberGlabKnownHost(`host${generation}.test`, 'connection')
    results.push(await weakResult('connection'))
  }
  await collect()
  expect(results.filter((result) => result.deref() !== undefined)).toHaveLength(1)
  await expect(getGlabKnownHosts('connection')).resolves.toEqual(['gitlab.com', 'host16.test'])
  expect(execute).not.toHaveBeenCalled()
})

it('does not retain a delayed old-generation result after a replacement answers', async () => {
  const old = deferred()
  generations.set('connection', 1)
  execute.mockReturnValueOnce(old.promise)
  const oldResult = weakResult('connection')
  generations.set('connection', 2)
  execute.mockResolvedValueOnce(response('replacement.test'))
  await expect(getGlabKnownHosts('connection')).resolves.toEqual(['gitlab.com', 'replacement.test'])
  old.resolve(response('retired.test'))
  const reference = await oldResult
  await collect()
  expect(reference.deref()).toBeUndefined()
  await expect(getGlabKnownHosts('connection')).resolves.toEqual(['gitlab.com', 'replacement.test'])
  expect(execute).toHaveBeenCalledTimes(2)
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

it('keeps native, WSL and other connection caches when one generation changes', async () => {
  execute
    .mockResolvedValueOnce(response('native.test'))
    .mockResolvedValueOnce(response('ubuntu.test'))
    .mockResolvedValueOnce(response('debian.test'))
    .mockResolvedValueOnce(response('connection-a.test'))
    .mockResolvedValueOnce(response('connection-b.test'))
  const native = await getGlabKnownHosts()
  const ubuntu = await getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' })
  const debian = await getGlabKnownHosts(undefined, { wslDistro: 'Debian' })
  await getGlabKnownHosts('connection-a')
  const other = await getGlabKnownHosts('connection-b')
  generations.set('connection-a', 1)
  rememberGlabKnownHost('replacement.test', 'connection-a')
  await expect(getGlabKnownHosts('connection-a')).resolves.toEqual([
    'gitlab.com',
    'replacement.test'
  ])
  await expect(getGlabKnownHosts()).resolves.toBe(native)
  await expect(getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' })).resolves.toBe(ubuntu)
  await expect(getGlabKnownHosts(undefined, { wslDistro: 'Debian' })).resolves.toBe(debian)
  await expect(getGlabKnownHosts('connection-b')).resolves.toBe(other)
  expect(execute).toHaveBeenCalledTimes(5)
})

it('does not serve a retired generation after the current probe fails', async () => {
  execute.mockResolvedValueOnce(response('retired.test'))
  await getGlabKnownHosts('connection')
  generations.set('connection', 1)
  execute.mockRejectedValueOnce(new Error('current host unavailable'))
  await expect(getGlabKnownHosts('connection')).resolves.toEqual(['gitlab.com'])
  execute.mockResolvedValueOnce(response('current.test'))
  await expect(getGlabKnownHosts('connection')).resolves.toEqual(['gitlab.com', 'current.test'])
  expect(execute).toHaveBeenCalledTimes(3)
})
