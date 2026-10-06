import { ChildProcess } from 'node:child_process'
import type * as ChildProcessModule from 'node:child_process'
import type * as FsPromises from 'node:fs/promises'
import { getEventListeners } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { spawnMock, statMock, retryMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  statMock: vi.fn(),
  retryMock: vi.fn()
}))
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
  pathRipgrepCommand: () => '/fallback/rg',
  retryRipgrepOnPathAfterLaunchFailure: retryMock
}))
import { listFilesWithRg } from './fs-handler-list-files'

function child(spawned: boolean) {
  const result = new ChildProcess()
  Object.defineProperties(result, {
    stdout: { value: new PassThrough() },
    stderr: { value: new PassThrough() }
  })
  Object.defineProperty(result, 'pid', { value: spawned ? 4321 : undefined })
  result.kill = vi.fn(() => true)
  return result
}

async function drainDiagnosis(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  spawnMock.mockReset()
  statMock.mockReset().mockResolvedValue({ isDirectory: () => false })
  retryMock.mockReset().mockResolvedValue(false)
})
afterEach(() => vi.useRealTimers())

it('settles an unexpected diagnosis rejection without leaving a listing pending', async () => {
  retryMock.mockRejectedValue('diagnosis failed')
  const failed = child(false)
  spawnMock.mockReturnValue(failed)
  const controller = new AbortController()
  const result = listFilesWithRg('/missing/root', [], { signal: controller.signal })
  const rejected = expect(result).rejects.toThrow('diagnosis failed')
  failed.emit('error', new Error('spawn ENOENT'))
  await rejected
  expect(spawnMock).toHaveBeenCalledOnce()
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('skips diagnosis when a canceled listing resumes its retry check', async () => {
  let completeRetry: (value: boolean) => void = () => undefined
  retryMock.mockReturnValue(
    new Promise<boolean>((resolve) => {
      completeRetry = resolve
    })
  )
  const failed = child(false)
  const probe = child(true)
  spawnMock.mockReturnValueOnce(failed).mockReturnValue(probe)
  const controller = new AbortController()
  const result = listFilesWithRg('/missing/root', [], { signal: controller.signal })
  const canceled = expect(result).rejects.toMatchObject({ name: 'FileListingCancelledError' })
  failed.emit('error', new Error('spawn ENOENT'))
  expect(retryMock).toHaveBeenCalledOnce()
  controller.abort()
  await canceled
  completeRetry(false)
  await drainDiagnosis()
  const statCalls = statMock.mock.calls.length
  probe.emit('close', 0)
  await drainDiagnosis()
  expect(statCalls).toBe(0)
  expect(spawnMock).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('skips version probes when cancellation wins a pending cwd check', async () => {
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
  const result = listFilesWithRg('/missing/root', [], { signal: controller.signal })
  const canceled = expect(result).rejects.toMatchObject({ name: 'FileListingCancelledError' })
  failed.emit('error', new Error('spawn ENOENT'))
  await drainDiagnosis()
  expect(statMock).toHaveBeenCalledOnce()
  controller.abort()
  await canceled
  completeStat({ isDirectory: () => false })
  await drainDiagnosis()
  const spawnCalls = spawnMock.mock.calls.length
  probe.emit('close', 0)
  await drainDiagnosis()
  expect(spawnCalls).toBe(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('terminates a running diagnosis probe when its listing is canceled', async () => {
  const failed = child(false)
  const probe = child(true)
  spawnMock.mockReturnValueOnce(failed).mockReturnValue(probe)
  const controller = new AbortController()
  const result = listFilesWithRg('/missing/root', [], { signal: controller.signal })
  const canceled = expect(result).rejects.toMatchObject({ name: 'FileListingCancelledError' })
  failed.emit('error', new Error('spawn ENOENT'))
  await drainDiagnosis()
  expect(spawnMock).toHaveBeenCalledTimes(2)
  expect(spawnMock.mock.calls[1][1]).toEqual(['--version'])
  controller.abort()
  await canceled
  const killCalls = vi.mocked(probe.kill).mock.calls.length
  const closeListeners = probe.listenerCount('close')
  probe.emit('close', 0)
  await drainDiagnosis()
  expect(killCalls).toBe(1)
  expect(closeListeners).toBe(0)
  expect(spawnMock).toHaveBeenCalledTimes(2)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})
