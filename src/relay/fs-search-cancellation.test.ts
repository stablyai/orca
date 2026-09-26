import { ChildProcess } from 'node:child_process'
import type * as ChildProcessModule from 'node:child_process'
import type * as RipgrepAvailability from '../shared/ripgrep-process-availability'
import { getEventListeners } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, resolveCommand, retryOnPath, classifyFailure } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  resolveCommand: vi.fn((): string | null => '/tools/rg'),
  retryOnPath: vi.fn(async () => false),
  classifyFailure: vi.fn(
    async (): Promise<'cwd-unreachable' | 'ripgrep-unavailable'> => 'ripgrep-unavailable'
  )
}))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  spawn: spawnMock
}))
vi.mock('../shared/ripgrep-process-availability', async (importOriginal) => ({
  ...(await importOriginal<typeof RipgrepAvailability>()),
  classifyRipgrepLaunchFailure: classifyFailure
}))
vi.mock('./relay-bundled-ripgrep', () => ({
  resolveRelayRipgrepCommand: resolveCommand,
  pathRipgrepCommand: () => '/tools/rg',
  retryRipgrepOnPathAfterLaunchFailure: retryOnPath
}))

import { searchWithRg } from './fs-handler-utils'
import { searchWithGitGrep } from './fs-handler-git-fallback'
import { RelayDispatcher } from './dispatcher'
import { FsHandler } from './fs-handler'
import { RelayContext } from './context'
import { encodeJsonRpcFrame } from './protocol'

function createProcess(spawned = true) {
  const child = new ChildProcess()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  Object.defineProperty(child, 'pid', { value: spawned ? 4321 : undefined })
  child.kill = vi.fn(() => true)
  return child
}

beforeEach(() => {
  vi.useFakeTimers()
  spawnMock.mockReset()
  resolveCommand.mockReturnValue('/tools/rg')
  retryOnPath.mockResolvedValue(false)
  classifyFailure.mockResolvedValue('ripgrep-unavailable')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe.each([
  { name: 'ripgrep', search: searchWithRg },
  { name: 'git grep', search: searchWithGitGrep }
])('relay $name search cancellation', ({ search }) => {
  it('does not start a child for an already canceled request', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      search('/remote/root', 'needle', { maxResults: 100, signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('releases a canceled search even when its child never reports an exit', async () => {
    const child = createProcess()
    spawnMock.mockReturnValue(child)
    const controller = new AbortController()
    const result = search('/remote/root', 'needle', { maxResults: 100, signal: controller.signal })
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    child.stdout?.emit('data', 'unfinished output')

    controller.abort()
    await rejected

    expect(child.kill).toHaveBeenCalledOnce()
    expect(child.stdout?.listenerCount('data')).toBe(0)
    expect(child.stderr?.listenerCount('data')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    child.emit('close', 0, null)
    expect(spawnMock).toHaveBeenCalledOnce()
  })

  it('removes the abort listener after normal completion', async () => {
    const child = createProcess()
    spawnMock.mockReturnValue(child)
    const controller = new AbortController()
    const result = search('/remote/root', 'needle', { maxResults: 100, signal: controller.signal })
    child.emit('close', 0, null)
    await expect(result).resolves.toEqual({ files: [], totalMatches: 0, truncated: false })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    controller.abort()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('absorbs a queued spawn error after cancellation without signaling a missing PID', async () => {
    const child = createProcess(false)
    spawnMock.mockReturnValue(child)
    const controller = new AbortController()
    const result = search('/remote/root', 'needle', { maxResults: 100, signal: controller.signal })
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(child.kill).not.toHaveBeenCalled()
    expect(() => child.emit('error', new Error('spawn ENOENT'))).not.toThrow()
    expect(child.listenerCount('error')).toBe(0)
  })
})

it('does not retry on PATH after cancellation during launch-failure diagnosis', async () => {
  let finishRetry: (retry: boolean) => void = () => undefined
  retryOnPath.mockReturnValueOnce(
    new Promise<boolean>((resolve) => {
      finishRetry = resolve
    })
  )
  const child = createProcess(false)
  spawnMock.mockReturnValue(child)
  const controller = new AbortController()
  const result = searchWithRg('/remote/root', 'needle', {
    maxResults: 100,
    signal: controller.signal
  })
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  child.emit('error', new Error('spawn ENOENT'))
  controller.abort()
  await rejected
  finishRetry(true)
  await Promise.resolve()
  expect(spawnMock).toHaveBeenCalledOnce()
})

it('settles cancellation while launch-failure classification is still pending', async () => {
  let finishClassification: (failure: 'ripgrep-unavailable') => void = () => undefined
  classifyFailure.mockReturnValueOnce(
    new Promise((resolve) => {
      finishClassification = resolve
    })
  )
  const child = createProcess(false)
  spawnMock.mockReturnValue(child)
  const controller = new AbortController()
  const result = searchWithRg('/remote/root', 'needle', {
    maxResults: 100,
    signal: controller.signal
  })
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  child.emit('error', new Error('spawn ENOENT'))
  await Promise.resolve()
  controller.abort()
  await rejected
  finishClassification('ripgrep-unavailable')
  await Promise.resolve()
  expect(spawnMock).toHaveBeenCalledOnce()
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})

describe.each(['ripgrep', 'git grep'])('relay dispatcher cancels %s', (backend) => {
  it.each(['detach', 'rpc.cancel', 'dispose'])(
    'removes every search child and listener on %s',
    async (cause) => {
      if (backend === 'git grep') {
        resolveCommand.mockReturnValue(null)
      }
      const children: ReturnType<typeof createProcess>[] = []
      spawnMock.mockImplementation(() => {
        const child = createProcess()
        children.push(child)
        return child
      })
      const dispatcher = new RelayDispatcher(() => true)
      const handler = new FsHandler(dispatcher, new RelayContext(), {
        dispose: vi.fn(),
        forgetRoot: vi.fn(),
        subscribe: vi.fn()
      })
      try {
        const client = dispatcher.attachClient(() => true)
        for (let id = 1; id <= 25; id++) {
          dispatcher.feedClient(
            client,
            encodeJsonRpcFrame(
              {
                jsonrpc: '2.0',
                id,
                method: 'fs.search',
                params: { rootPath: '/remote/root', query: 'needle' }
              },
              id,
              0
            )
          )
        }
        await Promise.resolve()
        expect(children).toHaveLength(25)
        if (cause === 'detach') {
          dispatcher.detachClient(client)
        } else if (cause === 'dispose') {
          dispatcher.dispose()
        } else {
          for (let id = 1; id <= 25; id++) {
            dispatcher.feedClient(
              client,
              encodeJsonRpcFrame(
                { jsonrpc: '2.0', method: 'rpc.cancel', params: { id } },
                id + 25,
                0
              )
            )
          }
        }
        await Promise.resolve()
        for (const child of children) {
          expect(child.kill).toHaveBeenCalledOnce()
          expect(child.stdout?.listenerCount('data')).toBe(0)
          expect(child.listenerCount('close')).toBe(0)
        }
        expect(spawnMock).toHaveBeenCalledTimes(25)
      } finally {
        handler.dispose()
        dispatcher.dispose()
        for (const child of children) {
          child.emit('close', 0, null)
        }
      }
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})
