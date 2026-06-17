import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsChangeEvent } from '../../shared/types'

type MockChild = {
  killed: boolean
  sentMessages: unknown[]
  forkOptions: { env?: NodeJS.ProcessEnv }
  stderr: { on: ReturnType<typeof vi.fn> }
  on(event: string, listener: (...args: unknown[]) => void): MockChild
  once(event: string, listener: (...args: unknown[]) => void): MockChild
  off(event: string, listener: (...args: unknown[]) => void): MockChild
  send(message: unknown): void
  kill(): void
  emit(event: string, ...args: unknown[]): void
}

const childState = vi.hoisted(() => {
  const instances: MockChild[] = []
  class MockChildImpl {
    killed = false
    sentMessages: unknown[] = []
    stderr = { on: vi.fn() }
    private listeners = new Map<
      string,
      { listener: (...args: unknown[]) => void; once: boolean }[]
    >()

    constructor(
      _entryPath: string,
      _args: string[],
      public forkOptions: { env?: NodeJS.ProcessEnv }
    ) {
      instances.push(this as unknown as MockChild)
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      const list = this.listeners.get(event) ?? []
      list.push({ listener, once: false })
      this.listeners.set(event, list)
      return this
    }

    once(event: string, listener: (...args: unknown[]) => void): this {
      const list = this.listeners.get(event) ?? []
      list.push({ listener, once: true })
      this.listeners.set(event, list)
      return this
    }

    off(event: string, listener: (...args: unknown[]) => void): this {
      const list = this.listeners.get(event) ?? []
      this.listeners.set(
        event,
        list.filter((entry) => entry.listener !== listener)
      )
      return this
    }

    send(message: unknown): void {
      this.sentMessages.push(message)
    }

    kill(): void {
      this.killed = true
    }

    emit(event: string, ...args: unknown[]): void {
      const entries = this.listeners.get(event)?.slice() ?? []
      for (const entry of entries) {
        if (entry.once) {
          this.off(event, entry.listener)
        }
        entry.listener(...args)
      }
    }
  }

  const forkMock = vi.fn(
    (entryPath: string, args: string[], options: { env?: NodeJS.ProcessEnv }) =>
      new MockChildImpl(entryPath, args, options)
  )

  return { forkMock, instances }
})

vi.mock('electron', () => ({
  app: { isPackaged: false }
}))

vi.mock('child_process', () => ({
  fork: childState.forkMock
}))

import { watchFilesystemOutOfProcess } from './filesystem-watcher-process-host'

function lastChild(): MockChild {
  const child = childState.instances.at(-1)
  if (!child) {
    throw new Error('no child spawned')
  }
  return child
}

describe('watchFilesystemOutOfProcess', () => {
  beforeEach(() => {
    childState.instances.length = 0
    childState.forkMock.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('forks a Node child and forwards precise file-explorer events', async () => {
    const onEvents = vi.fn<(events: FsChangeEvent[]) => void>()
    const promise = watchFilesystemOutOfProcess('/repo', ['.git'], onEvents)
    const child = lastChild()
    expect(child.forkOptions.env?.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(JSON.parse(child.forkOptions.env?.ORCA_FILESYSTEM_WATCHER_CHILD_DATA ?? '{}')).toEqual({
      rootPath: '/repo',
      ignore: ['.git']
    })

    child.emit('message', { type: 'ready' })
    const dispose = await promise
    expect(typeof dispose).toBe('function')

    const events: FsChangeEvent[] = [
      { kind: 'update', absolutePath: '/repo/a.txt', isDirectory: false }
    ]
    child.emit('message', { type: 'events', events })
    expect(onEvents).toHaveBeenCalledWith(events)
  })

  it('unsubscribes the child and waits for clean exit', async () => {
    const promise = watchFilesystemOutOfProcess('/repo', ['.git'], vi.fn())
    const child = lastChild()
    child.emit('message', { type: 'ready' })
    const dispose = await promise

    const disposed = dispose()
    expect(child.sentMessages).toContainEqual({ type: 'unsubscribe' })
    child.emit('exit', 0, null)
    await disposed
    expect(child.killed).toBe(false)
  })

  it('emits overflow and restarts if a live child exits', async () => {
    vi.useFakeTimers()
    const onEvents = vi.fn<(events: FsChangeEvent[]) => void>()
    const promise = watchFilesystemOutOfProcess('/repo', ['.git'], onEvents)
    const child = lastChild()
    child.emit('message', { type: 'ready' })
    await promise

    child.emit('exit', null, 'SIGTRAP')
    expect(onEvents).toHaveBeenCalledWith([{ kind: 'overflow', absolutePath: '/repo' }])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(childState.instances).toHaveLength(2)
  })

  it('restarts again if a replacement child errors before ready', async () => {
    vi.useFakeTimers()
    const onEvents = vi.fn<(events: FsChangeEvent[]) => void>()
    const promise = watchFilesystemOutOfProcess('/repo', ['.git'], onEvents)
    const child = lastChild()
    child.emit('message', { type: 'ready' })
    await promise

    child.emit('exit', null, 'SIGTRAP')
    await vi.advanceTimersByTimeAsync(1_000)
    const replacement = lastChild()

    replacement.emit('message', { type: 'error', message: 'addon missing' })
    expect(replacement.killed).toBe(true)
    replacement.emit('exit', 1, null)
    expect(onEvents).toHaveBeenCalledWith([{ kind: 'overflow', absolutePath: '/repo' }])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(childState.instances).toHaveLength(3)
  })
})
