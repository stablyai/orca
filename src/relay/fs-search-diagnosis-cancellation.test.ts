import { ChildProcess } from 'node:child_process'
import type * as ChildProcessModule from 'node:child_process'
import type * as FsPromises from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { getEventListeners } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { spawnMock, statMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), statMock: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  spawn: spawnMock
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  stat: statMock,
  access: vi.fn(async () => undefined)
}))
vi.mock('./relay-bundled-ripgrep', () => ({
  resolveRelayRipgrepCommand: () => '/tools/rg',
  pathRipgrepCommand: () => '/tools/rg',
  retryRipgrepOnPathAfterLaunchFailure: async () => false
}))
import { searchWithRg } from './fs-handler-utils'
import { classifyRipgrepLaunchFailure } from '../shared/ripgrep-process-availability'
import { searchWithGitGrep } from './fs-handler-git-search'

function child(spawned: boolean) {
  const result = new ChildProcess()
  result.stdout = new PassThrough()
  result.stderr = new PassThrough()
  Object.defineProperty(result, 'pid', { value: spawned ? 4321 : undefined })
  result.kill = vi.fn(() => true)
  return result
}
beforeEach(() => {
  vi.useFakeTimers()
  spawnMock.mockReset()
  statMock.mockReset().mockResolvedValue({ isDirectory: () => false })
})
afterEach(() => vi.useRealTimers())
it('does not start a version probe after canceled launch diagnosis resumes', async () => {
  vi.useFakeTimers()
  let completeStat: (value: { isDirectory: () => boolean }) => void = () => undefined
  statMock.mockReturnValue(
    new Promise((resolve) => {
      completeStat = resolve
    })
  )
  const failed = child(false)
  const probe = child(true)
  spawnMock.mockReturnValueOnce(failed).mockReturnValue(probe)
  const controller = new AbortController()
  const search = searchWithRg('/missing/root', 'needle', {
    maxResults: 100,
    signal: controller.signal
  })
  const canceled = expect(search).rejects.toMatchObject({ name: 'AbortError' })
  failed.emit('error', new Error('spawn ENOENT'))
  for (let tick = 0; tick < 5; tick += 1) {
    await Promise.resolve()
  }
  expect(statMock).toHaveBeenCalledOnce()
  controller.abort()
  await canceled
  completeStat({ isDirectory: () => false })
  for (let tick = 0; tick < 10; tick += 1) {
    await Promise.resolve()
  }
  const observed = spawnMock.mock.calls.map((args) => [args[0], args[1]])
  probe.emit('close', 0)
  expect(observed).toEqual([['/tools/rg', expect.not.arrayContaining(['--version'])]])
})

for (const [name, search] of [
  ['rg', searchWithRg],
  ['git', searchWithGitGrep]
] as const) {
  it.each(['emit', 'throw'])(
    `settles ${name} cancellation when kill fails via %s`,
    async (mode) => {
      const process = child(true)
      process.kill = vi.fn(() => {
        const error = Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
        if (mode === 'throw') {
          throw error
        }
        process.emit('error', error)
        return false
      })
      spawnMock.mockReturnValue(process)
      const controller = new AbortController()
      const result = search('/root', 'needle', { maxResults: 100, signal: controller.signal })
      const canceled = expect(result).rejects.toMatchObject({ name: 'AbortError' })
      expect(() => controller.abort()).not.toThrow()
      await canceled
      expect(process.kill).toHaveBeenCalledOnce()
      expect(process.stdout?.listenerCount('data')).toBe(0)
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
}

it('terminates an active version probe and skips remaining candidates on abort', async () => {
  const probe = child(true)
  spawnMock.mockReturnValue(probe)
  const controller = new AbortController()
  const diagnosis = classifyRipgrepLaunchFailure(
    '/missing/root',
    ['/tools/rg', '/fallback/rg'],
    {},
    controller.signal
  )
  const canceled = expect(diagnosis).rejects.toMatchObject({ name: 'AbortError' })
  for (let tick = 0; tick < 5; tick += 1) {
    await Promise.resolve()
  }
  expect(spawnMock).toHaveBeenCalledOnce()
  controller.abort()
  await canceled
  expect(probe.kill).toHaveBeenCalledOnce()
  expect(probe.listenerCount('close')).toBe(0)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
  probe.emit('close', 0)
  expect(spawnMock).toHaveBeenCalledOnce()
})

it('preserves candidate fallback and cwd classification for a live caller', async () => {
  const missing = child(true)
  const available = child(true)
  spawnMock.mockReturnValueOnce(missing).mockReturnValueOnce(available)
  const controller = new AbortController()
  const diagnosis = classifyRipgrepLaunchFailure(
    '/missing/root',
    ['/tools/rg', '/fallback/rg'],
    {},
    controller.signal
  )
  for (let tick = 0; tick < 5; tick += 1) {
    await Promise.resolve()
  }
  missing.emit('close', 1)
  for (let tick = 0; tick < 5; tick += 1) {
    await Promise.resolve()
  }
  available.emit('close', 0)
  await expect(diagnosis).resolves.toBe('cwd-unreachable')
  expect(spawnMock.mock.calls.map(([program, args]) => [program, args])).toEqual([
    ['/tools/rg', ['--version']],
    ['/fallback/rg', ['--version']]
  ])
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
  expect(missing.kill).not.toHaveBeenCalled()
  expect(available.kill).not.toHaveBeenCalled()
})

it.each(['emit', 'throw'])(
  'settles version-probe cancellation when kill fails via %s',
  async (mode) => {
    const probe = child(true)
    probe.kill = vi.fn(() => {
      const error = Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
      if (mode === 'throw') {
        throw error
      }
      probe.emit('error', error)
      return false
    })
    spawnMock.mockReturnValue(probe)
    const controller = new AbortController()
    const diagnosis = classifyRipgrepLaunchFailure(
      '/missing/root',
      ['/tools/rg', '/fallback/rg'],
      {},
      controller.signal
    )
    const canceled = expect(diagnosis).rejects.toMatchObject({ name: 'AbortError' })
    for (let tick = 0; tick < 5; tick += 1) {
      await Promise.resolve()
    }
    expect(() => controller.abort()).not.toThrow()
    await canceled
    expect(probe.kill).toHaveBeenCalledOnce()
    expect(spawnMock).toHaveBeenCalledOnce()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  }
)
