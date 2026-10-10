import { EventEmitter } from 'node:events'
import { statSync, watch } from 'node:fs'
import type * as Fs from 'node:fs'
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { watcherState } = vi.hoisted(() => ({
  watcherState: new Map<
    string,
    {
      callback: (eventType: string, fileName: string | Buffer | null) => void
      watcher: EventEmitter & { close: () => void }
    }
  >()
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof Fs>('node:fs')
  return {
    ...actual,
    statSync: vi.fn(actual.statSync),
    watch: vi.fn(
      (
        path: string,
        _options: unknown,
        callback: (eventType: string, fileName: string | Buffer | null) => void
      ) => {
        const watcher = new EventEmitter() as EventEmitter & { close: () => void }
        watcher.close = () => watcher.emit('close')
        watcherState.set(path, { callback, watcher })
        return watcher
      }
    )
  }
})
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  return { ...actual, stat: vi.fn(actual.stat) }
})

import { startShallowWatcher } from './parcel-watcher-shallow-subscription'

function emit(path: string, fileName: string): void {
  watcherState.get(path)?.callback('change', fileName)
}

describe('shallow watcher subscription', () => {
  beforeEach(() => {
    watcherState.clear()
    vi.mocked(statSync).mockReset()
    vi.mocked(stat).mockReset()
  })

  it('emits only included primary files, including an existing nested directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-shallow-watcher-'))
    try {
      await mkdir(join(root, 'logs'))
      const events: string[] = []
      const { promise, resolve } = Promise.withResolvers<void>()
      const subscription = startShallowWatcher(
        root,
        ['HEAD', 'config', 'logs/HEAD'],
        (nextEvents) => {
          events.push(...nextEvents.map((event) => event.path))
          if (
            events.includes(join(root, 'config')) &&
            events.includes(join(root, 'logs', 'HEAD'))
          ) {
            resolve()
          }
        },
        (error) => {
          throw error
        }
      )

      emit(root, 'config')
      emit(join(root, 'logs'), 'HEAD')
      await promise

      expect(events).toContain(join(root, 'config'))
      expect(events).toContain(join(root, 'logs', 'HEAD'))
      expect(events).not.toContain(join(root, 'unrelated'))
      await subscription.unsubscribe()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not forward events after unsubscribe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-shallow-watcher-'))
    try {
      const events: string[] = []
      const subscription = startShallowWatcher(
        root,
        ['HEAD'],
        (nextEvents) => events.push(...nextEvents.map((event) => event.path)),
        (error) => {
          throw error
        }
      )
      await subscription.unsubscribe()
      emit(root, 'HEAD')
      const { promise, resolve } = Promise.withResolvers<void>()
      setImmediate(resolve)
      await promise
      expect(events).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'preserves a literal backslash in an included filename',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-shallow-watcher-'))
      const events: string[] = []
      const subscription = startShallowWatcher(
        root,
        ['plugin\\name'],
        (nextEvents) => events.push(...nextEvents.map((event) => event.path)),
        (error) => {
          throw error
        }
      )
      try {
        emit(root, 'plugin\\name')
        expect(events).toEqual([join(root, 'plugin\\name')])
      } finally {
        await subscription.unsubscribe()
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('rebinds a nested directory that is replaced, which leaves fs.watch deaf', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-shallow-watcher-'))
    try {
      await mkdir(join(root, 'logs'))
      const events: string[] = []
      const subscription = startShallowWatcher(
        root,
        ['HEAD', 'logs/HEAD'],
        (nextEvents) => events.push(...nextEvents.map((event) => event.path)),
        (error) => {
          throw error
        }
      )
      const firstNested = watcherState.get(join(root, 'logs'))?.watcher

      // A 'rename' for the nested dir means the inode was swapped, so the old
      // binding is dead and must be replaced rather than reused.
      watcherState.get(root)?.callback('rename', 'logs')

      expect(watcherState.get(join(root, 'logs'))?.watcher).not.toBe(firstNested)
      events.length = 0
      emit(join(root, 'logs'), 'HEAD')
      expect(events).toContain(join(root, 'logs', 'HEAD'))
      await subscription.unsubscribe()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reuses the nested binding for an ordinary change event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-shallow-watcher-'))
    try {
      await mkdir(join(root, 'logs'))
      const subscription = startShallowWatcher(
        root,
        ['logs/HEAD'],
        () => {},
        (error) => {
          throw error
        }
      )
      const firstNested = watcherState.get(join(root, 'logs'))?.watcher
      watcherState.get(root)?.callback('change', 'logs')
      expect(watcherState.get(join(root, 'logs'))?.watcher).toBe(firstNested)
      await subscription.unsubscribe()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retries a failed replacement binding and resyncs after recovery', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'orca-shallow-watcher-'))
    const logs = join(root, 'logs')
    let subscription: ReturnType<typeof startShallowWatcher> | undefined
    try {
      await mkdir(logs)
      const events: string[] = []
      subscription = startShallowWatcher(
        root,
        ['HEAD', 'logs/HEAD'],
        (nextEvents) => events.push(...nextEvents.map((event) => event.path)),
        (error) => {
          throw error
        }
      )
      const initialAttempts = vi.mocked(watch).mock.calls.length
      await rename(logs, join(root, 'old-logs'))
      await mkdir(logs)
      vi.mocked(watch).mockImplementationOnce(() => {
        throw new Error('ENOSPC: watch limit reached')
      })

      await vi.advanceTimersByTimeAsync(30_000)
      await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(initialAttempts + 1))
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(initialAttempts + 2))

      expect(events).toContain(join(logs, 'HEAD'))
      events.length = 0
      emit(logs, 'HEAD')
      expect(events).toEqual([join(logs, 'HEAD')])
    } finally {
      await subscription?.unsubscribe()
      vi.useRealTimers()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    { parent: '', field: 'dev' },
    { parent: '', field: 'ino' },
    { parent: 'logs', field: 'dev' },
    { parent: 'logs', field: 'ino' }
  ] as const)(
    'retains full $field precision at startup and after silent $parent replacement',
    async ({ parent, field }) => {
      vi.useFakeTimers()
      const root = await mkdtemp(join(tmpdir(), 'orca-shallow-large-identity-'))
      const directory = join(root, parent)
      const previousDirectory = join(dirname(directory), `${basename(directory)}-previous`)
      let subscription: ReturnType<typeof startShallowWatcher> | undefined
      try {
        if (parent) {
          await mkdir(directory)
        }
        const previousId = 9_007_199_254_740_995n
        const nextId = previousId + 1n
        expect(Number(previousId)).toBe(Number(nextId))
        const previousIdentity = { dev: previousId, ino: previousId }
        const nextIdentity = { ...previousIdentity, [field]: nextId }
        const previousNumeric = Object.assign(statSync(directory), {
          dev: Number(previousIdentity.dev),
          ino: Number(previousIdentity.ino)
        })
        const previousBigInt = Object.assign(
          statSync(directory, { bigint: true }),
          previousIdentity
        )
        const nextNumeric = Object.assign(statSync(directory), {
          dev: Number(nextIdentity.dev),
          ino: Number(nextIdentity.ino)
        })
        const nextBigInt = Object.assign(statSync(directory, { bigint: true }), nextIdentity)
        vi.mocked(statSync).mockClear()
        vi.mocked(stat).mockClear()
        vi.mocked(statSync).mockImplementationOnce((_path, options) =>
          options?.bigint ? previousBigInt : previousNumeric
        )
        vi.mocked(stat)
          .mockImplementationOnce(async (_path, options) =>
            options?.bigint ? previousBigInt : previousNumeric
          )
          .mockImplementationOnce(async (_path, options) =>
            options?.bigint ? nextBigInt : nextNumeric
          )
          .mockImplementationOnce(async (_path, options) =>
            options?.bigint ? nextBigInt : nextNumeric
          )
        const events: string[] = []
        subscription = startShallowWatcher(
          root,
          [join(parent, 'HEAD')],
          (nextEvents) => events.push(...nextEvents.map((event) => event.path)),
          (error) => {
            throw error
          }
        )
        const firstWatcher = watcherState.get(directory)?.watcher
        expect(firstWatcher).toBeDefined()
        await vi.advanceTimersByTimeAsync(30_000)
        expect(watcherState.get(directory)?.watcher).toBe(firstWatcher)
        expect(events).toEqual([])

        await rename(directory, previousDirectory)
        await mkdir(directory)
        await vi.advanceTimersByTimeAsync(30_000)
        expect(watcherState.get(directory)?.watcher).not.toBe(firstWatcher)
        expect(events).toEqual([join(directory, 'HEAD')])
        await vi.advanceTimersByTimeAsync(30_000)
        expect(events).toEqual([join(directory, 'HEAD')])
        events.length = 0
        emit(directory, 'HEAD')
        expect(events).toEqual([join(directory, 'HEAD')])
        expect(statSync).toHaveBeenCalledExactlyOnceWith(directory, { bigint: true })
        expect(stat).toHaveBeenCalledTimes(3)
        for (const args of vi.mocked(stat).mock.calls) {
          expect(args).toEqual([directory, { bigint: true }])
        }
      } finally {
        await subscription?.unsubscribe()
        vi.useRealTimers()
        await rm(root, { recursive: true, force: true })
        await rm(previousDirectory, { recursive: true, force: true })
      }
    }
  )

  it.each(['', 'logs'])(
    'recovers an inode-less %s replacement while ignoring ordinary timestamp changes',
    async (parent) => {
      vi.useFakeTimers()
      const root = await mkdtemp(join(tmpdir(), 'orca-shallow-inode-less-'))
      const directory = join(root, parent)
      const previousDirectory = join(dirname(directory), `${basename(directory)}-previous`)
      let subscription: ReturnType<typeof startShallowWatcher> | undefined
      try {
        if (parent) {
          await mkdir(directory)
        }
        const previousBirthtime = 9_007_199_254_740_995n
        const nextBirthtime = previousBirthtime + 1n
        const previousIdentity = { dev: 1n, ino: 0n, birthtimeNs: previousBirthtime }
        const nextIdentity = { ...previousIdentity, birthtimeNs: nextBirthtime }
        const previous = Object.assign(statSync(directory, { bigint: true }), previousIdentity)
        const healthy = Object.assign(statSync(directory, { bigint: true }), previousIdentity, {
          mtimeNs: previous.mtimeNs + 1n,
          ctimeNs: previous.ctimeNs + 1n
        })
        const replacement = Object.assign(statSync(directory, { bigint: true }), nextIdentity)
        const healthyReplacement = Object.assign(
          statSync(directory, { bigint: true }),
          nextIdentity,
          {
            mtimeNs: replacement.mtimeNs + 1n,
            ctimeNs: replacement.ctimeNs + 1n
          }
        )
        vi.mocked(statSync).mockClear()
        vi.mocked(stat).mockClear()
        vi.mocked(statSync).mockReturnValueOnce(previous)
        vi.mocked(stat)
          .mockResolvedValueOnce(healthy)
          .mockResolvedValueOnce(replacement)
          .mockResolvedValueOnce(healthyReplacement)
        const events: string[] = []
        subscription = startShallowWatcher(
          root,
          [join(parent, 'HEAD')],
          (nextEvents) => events.push(...nextEvents.map((event) => event.path)),
          (error) => {
            throw error
          }
        )
        const firstWatcher = watcherState.get(directory)?.watcher
        const oldClosed = vi.fn()
        firstWatcher?.on('close', oldClosed)
        expect(firstWatcher).toBeDefined()
        await vi.advanceTimersByTimeAsync(30_000)
        expect(watcherState.get(directory)?.watcher).toBe(firstWatcher)
        expect(events).toEqual([])
        expect(oldClosed).not.toHaveBeenCalled()

        await rename(directory, previousDirectory)
        await mkdir(directory)
        await vi.advanceTimersByTimeAsync(30_000)
        const replacementWatcher = watcherState.get(directory)?.watcher
        expect(replacementWatcher).not.toBe(firstWatcher)
        expect(oldClosed).toHaveBeenCalledOnce()
        expect(events).toEqual([join(directory, 'HEAD')])
        await vi.advanceTimersByTimeAsync(30_000)
        expect(watcherState.get(directory)?.watcher).toBe(replacementWatcher)
        expect(events).toEqual([join(directory, 'HEAD')])
        events.length = 0
        emit(directory, 'HEAD')
        expect(events).toEqual([join(directory, 'HEAD')])
      } finally {
        await subscription?.unsubscribe()
        vi.useRealTimers()
        await rm(root, { recursive: true, force: true })
        await rm(previousDirectory, { recursive: true, force: true })
      }
    }
  )

  it.each([
    { parent: '', birthtime: 'zero' },
    { parent: 'logs', birthtime: 'zero' },
    { parent: '', birthtime: 'ctime surrogate' },
    { parent: 'logs', birthtime: 'ctime surrogate' }
  ] as const)(
    'keeps native $parent watches live without churn when birth time is $birthtime',
    async ({ parent, birthtime }) => {
      vi.useFakeTimers()
      const root = await mkdtemp(join(tmpdir(), 'orca-shallow-unavailable-identity-'))
      const directory = join(root, parent)
      let subscription: ReturnType<typeof startShallowWatcher> | undefined
      try {
        if (parent) {
          await mkdir(directory)
        }
        const entry = (ctimeNs: bigint) =>
          Object.assign(statSync(directory, { bigint: true }), {
            dev: 1n,
            ino: 0n,
            birthtimeNs: birthtime === 'zero' ? 0n : ctimeNs,
            ctimeNs,
            mtimeNs: ctimeNs
          })
        const initial = entry(1n)
        const edited = [entry(2n), entry(3n)]
        vi.mocked(statSync).mockClear()
        vi.mocked(stat).mockClear()
        vi.mocked(statSync).mockReturnValueOnce(initial)
        for (const current of edited) {
          vi.mocked(stat).mockResolvedValueOnce(current)
        }
        const events: string[] = []
        const onError = vi.fn()
        subscription = startShallowWatcher(
          root,
          [join(parent, 'HEAD')],
          (nextEvents) => events.push(...nextEvents.map((event) => event.path)),
          onError
        )
        const nativeWatcher = watcherState.get(directory)?.watcher
        expect(nativeWatcher).toBeDefined()
        const closed = vi.fn()
        nativeWatcher?.on('close', closed)
        const watchAttempts = vi.mocked(watch).mock.calls.length
        emit(directory, 'HEAD')
        expect(events).toEqual([join(directory, 'HEAD')])
        events.length = 0
        for (let tick = 0; tick < edited.length; tick++) {
          await vi.advanceTimersByTimeAsync(30_000)
          expect(watcherState.get(directory)?.watcher).toBe(nativeWatcher)
          expect(watch).toHaveBeenCalledTimes(watchAttempts)
          expect(events).toEqual([])
          expect(closed).not.toHaveBeenCalled()
          expect(vi.getTimerCount()).toBe(1)
        }
        emit(directory, 'HEAD')
        expect(events).toEqual([join(directory, 'HEAD')])
        expect(onError).not.toHaveBeenCalled()
      } finally {
        await subscription?.unsubscribe()
        expect(vi.getTimerCount()).toBe(0)
        vi.useRealTimers()
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it.each([
    { parent: '', replaced: true },
    { parent: 'logs', replaced: true },
    { parent: '', replaced: false },
    { parent: 'logs', replaced: false }
  ])(
    'admits a usable $parent identity once after an unknown binding (replaced=$replaced)',
    async ({ parent, replaced }) => {
      vi.useFakeTimers()
      const root = await mkdtemp(join(tmpdir(), 'orca-shallow-known-identity-'))
      const directory = join(root, parent)
      const previousDirectory = join(dirname(directory), `${basename(directory)}-previous`)
      let subscription: ReturnType<typeof startShallowWatcher> | undefined
      try {
        if (parent) {
          await mkdir(directory)
        }
        const unknown = Object.assign(statSync(directory, { bigint: true }), {
          dev: 1n,
          ino: 0n,
          birthtimeNs: replaced ? 0n : 1n,
          ctimeNs: 1n
        })
        const replacement = Object.assign(statSync(directory, { bigint: true }), {
          dev: 1n,
          ino: replaced ? 77n : 0n,
          birthtimeNs: unknown.birthtimeNs,
          ctimeNs: 2n
        })
        vi.mocked(statSync).mockClear()
        vi.mocked(stat).mockClear()
        vi.mocked(statSync).mockReturnValueOnce(unknown)
        vi.mocked(stat).mockResolvedValue(unknown)
        const events: string[] = []
        const onError = vi.fn()
        subscription = startShallowWatcher(
          root,
          [join(parent, 'HEAD')],
          (nextEvents) => events.push(...nextEvents.map((event) => event.path)),
          onError
        )
        const firstWatcher = watcherState.get(directory)?.watcher
        const watchAttempts = vi.mocked(watch).mock.calls.length
        expect(firstWatcher).toBeDefined()
        await vi.advanceTimersByTimeAsync(30_000)
        expect(watcherState.get(directory)?.watcher).toBe(firstWatcher)
        expect(events).toEqual([])
        if (replaced) {
          await rename(directory, previousDirectory)
          await mkdir(directory)
        }
        vi.mocked(stat).mockResolvedValue(replacement)
        await vi.advanceTimersByTimeAsync(29_999)
        expect(watch).toHaveBeenCalledTimes(watchAttempts)
        await vi.advanceTimersByTimeAsync(1)
        const recovered = watcherState.get(directory)?.watcher
        expect(recovered).not.toBe(firstWatcher)
        expect(watch).toHaveBeenCalledTimes(watchAttempts + 1)
        expect(events).toEqual([join(directory, 'HEAD')])
        await vi.advanceTimersByTimeAsync(30_000)
        expect(watcherState.get(directory)?.watcher).toBe(recovered)
        expect(watch).toHaveBeenCalledTimes(watchAttempts + 1)
        expect(events).toEqual([join(directory, 'HEAD')])
        for (const current of [unknown, replacement]) {
          vi.mocked(stat).mockResolvedValue(current)
          await vi.advanceTimersByTimeAsync(30_000)
          expect(watcherState.get(directory)?.watcher).toBe(recovered)
          expect(watch).toHaveBeenCalledTimes(watchAttempts + 1)
          expect(events).toEqual([join(directory, 'HEAD')])
        }
        events.length = 0
        emit(directory, 'HEAD')
        expect(events).toEqual([join(directory, 'HEAD')])
        expect(onError).not.toHaveBeenCalled()
      } finally {
        await subscription?.unsubscribe()
        vi.useRealTimers()
        await rm(root, { recursive: true, force: true })
        await rm(previousDirectory, { recursive: true, force: true })
      }
    }
  )

  it('resyncs included files when an initially missing directory becomes watchable', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'orca-shallow-watcher-'))
    let subscription: ReturnType<typeof startShallowWatcher> | undefined
    try {
      const defaultWatch = vi.mocked(watch).getMockImplementation()
      if (!defaultWatch) {
        throw new Error('Missing watcher test implementation')
      }
      vi.mocked(watch)
        .mockImplementationOnce(defaultWatch)
        .mockImplementationOnce(() => {
          throw new Error('ENOENT: logs directory does not exist')
        })
      const events: string[] = []
      subscription = startShallowWatcher(
        root,
        ['HEAD', 'logs/HEAD'],
        (nextEvents) => events.push(...nextEvents.map((event) => event.path)),
        (error) => {
          throw error
        }
      )
      const logs = join(root, 'logs')
      await mkdir(logs)
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.waitFor(() => expect(watcherState.has(logs)).toBe(true))

      expect(events).toContain(join(logs, 'HEAD'))
    } finally {
      await subscription?.unsubscribe()
      vi.useRealTimers()
      await rm(root, { recursive: true, force: true })
    }
  })
})
