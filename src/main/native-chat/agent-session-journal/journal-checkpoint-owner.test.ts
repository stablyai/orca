import { EventEmitter } from 'node:events'
import * as timers from 'node:timers'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { JournalCheckpointOwner } from './journal-checkpoint-owner'

vi.mock('node:timers', () => ({
  setTimeout: vi.fn((run: () => void, ms?: number) => globalThis.setTimeout(run, ms)),
  clearTimeout: vi.fn((timer: ReturnType<typeof globalThis.setTimeout>) =>
    globalThis.clearTimeout(timer)
  )
}))

class CheckpointThread extends EventEmitter {
  postMessage = vi.fn<(message: unknown) => void>()
  unref = vi.fn()
  terminate = vi.fn(async () => {
    this.emit('exit', 1)
    return 1
  })
}
const databases: Database.Database[] = []
const owners: JournalCheckpointOwner[] = []
function setup(
  timeoutMs = 1000,
  configure?: (worker: CheckpointThread, writer: Database.Database) => void
) {
  const writer = new Database(':memory:')
  databases.push(writer)
  const worker = new CheckpointThread()
  configure?.(worker, writer)
  const owner = new JournalCheckpointOwner(writer, ':memory:', { factory: () => worker, timeoutMs })
  owners.push(owner)
  return {
    writer,
    worker,
    owner,
    auto: () => writer.pragma('wal_autocheckpoint', { simple: true })
  }
}
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(owners.splice(0).map((owner) => owner.close()))
  for (const db of databases.splice(0)) {
    db.close()
  }
  vi.restoreAllMocks()
})

it('starts a bounded check after listeners and auto0, coalesces writes and cancels real unrefed deadlines', async () => {
  const { worker, owner, auto } = setup(1000, (thread, writer) => {
    thread.postMessage.mockImplementationOnce(() => {
      expect(thread.listenerCount('exit')).toBe(1)
      expect(thread.listenerCount('error')).toBe(1)
      expect(thread.listenerCount('message')).toBe(1)
      expect(writer.pragma('wal_autocheckpoint', { simple: true })).toBe(0)
    })
  })
  const firstCheck = vi.mocked(timers.setTimeout).mock.results.at(-1)?.value
  expect(firstCheck?.hasRef()).toBe(false)
  expect(auto()).toBe(0)
  expect(worker.unref).toHaveBeenCalledOnce()
  expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'check', id: 1 })
  owner.afterCommit()
  owner.afterCommit()
  expect(worker.postMessage).toHaveBeenCalledTimes(1)
  worker.emit('message', { type: 'checked' })
  worker.emit('message', { type: 'checked', id: 99 })
  expect(worker.postMessage).toHaveBeenCalledTimes(1)
  expect(timers.clearTimeout).not.toHaveBeenCalledWith(firstCheck)
  worker.emit('message', { type: 'checked', id: 1 })
  expect(timers.clearTimeout).toHaveBeenCalledWith(firstCheck)
  const secondCheck = vi.mocked(timers.setTimeout).mock.results.at(-1)?.value
  expect(secondCheck?.hasRef()).toBe(false)
  expect(worker.postMessage).toHaveBeenCalledTimes(2)
  worker.emit('message', { type: 'checked', id: 1 })
  expect(timers.clearTimeout).not.toHaveBeenCalledWith(secondCheck)
  worker.emit('message', { type: 'checked', id: 2 })
  expect(worker.postMessage).toHaveBeenCalledTimes(2)
  expect(timers.clearTimeout).toHaveBeenCalledWith(secondCheck)
  const deadlines = vi.mocked(timers.setTimeout).mock.calls.length
  await owner.close()
  expect(timers.setTimeout).toHaveBeenCalledTimes(deadlines)
  expect(worker.terminate).toHaveBeenCalledOnce()
})

it.each([
  'init-error',
  'init-exit',
  'init-send',
  'config',
  'error',
  'exit',
  'send',
  'initial-timeout',
  'check-timeout'
])('restores writer maintenance after %s and fences late or wrong-ID reports', async (failure) => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const { worker, owner, auto } = setup(25, (thread, writer) => {
    if (failure === 'init-send') {
      thread.postMessage.mockImplementationOnce(() => {
        throw new Error('initial post failed')
      })
    }
    if (failure === 'config') {
      const pragma = writer.pragma.bind(writer)
      vi.spyOn(writer, 'pragma').mockImplementation((sql, options) => {
        if (sql === 'wal_autocheckpoint = 0') {
          throw new Error('configuration failed')
        }
        return pragma(sql, options)
      })
    }
  })
  if (['error', 'exit', 'send', 'check-timeout'].includes(failure)) {
    worker.emit('message', { type: 'checked', id: 1 })
  }
  if (failure === 'send') {
    worker.postMessage.mockImplementationOnce(() => {
      throw new Error('post failed')
    })
    owner.afterCommit()
  } else if (failure === 'error' || failure === 'init-error') {
    worker.emit('error', new Error('checkpoint failed'))
  } else if (failure === 'exit' || failure === 'init-exit') {
    worker.emit('exit', 1)
  } else if (failure === 'initial-timeout' || failure === 'check-timeout') {
    if (failure === 'check-timeout') {
      owner.afterCommit()
    }
    // Silence/wrong IDs must time out even when no future write arrives.
    worker.emit('message', { type: 'checked', id: 99 })
    await vi.advanceTimersByTimeAsync(26)
  }
  expect(auto()).toBe(1000)
  const requests = worker.postMessage.mock.calls.length
  worker.emit('message', { type: 'checked', id: 1 })
  worker.emit('message', { type: 'checked', id: 2 })
  owner.afterCommit()
  expect(worker.postMessage).toHaveBeenCalledTimes(requests)
  expect(auto()).toBe(1000)
  expect(console.warn).toHaveBeenCalledOnce()
})

it.each(['terminate-first', 'exit-first'])(
  'joins actual termination and saved exit before writer restoration (%s)',
  async (order) => {
    const { worker, owner, auto } = setup()
    const termination = Promise.withResolvers<number>()
    worker.terminate.mockImplementation(() => termination.promise)
    let closed = false
    const closing = owner.close()
    expect(owner.close()).toBe(closing)
    const observed = closing.then(() => {
      closed = true
    })
    expect(worker.terminate).toHaveBeenCalledOnce()
    if (order === 'terminate-first') {
      termination.resolve(1)
    } else {
      worker.emit('exit', 1)
    }
    await Promise.resolve()
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(auto()).toBe(0)
    worker.emit('message', { type: 'checked', id: 1 })
    worker.emit('error', new Error('late error during close'))
    owner.afterCommit()
    expect(worker.postMessage).toHaveBeenCalledTimes(1)
    if (order === 'terminate-first') {
      worker.emit('exit', 1)
    } else {
      termination.resolve(1)
    }
    await observed
    expect(auto()).toBe(1000)
    expect(owner.close()).toBe(closing)
  }
)

it.each(['initial', 'pending', 'settled', 'already-exited'])(
  'retires the owned worker on close while %s',
  async (state) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { worker, owner, auto } = setup()
    if (state !== 'initial') {
      worker.emit('message', { type: 'checked', id: 1 })
    }
    if (state === 'pending') {
      owner.afterCommit()
    }
    if (state === 'already-exited') {
      worker.emit('exit', 1)
    }
    const attempts = worker.terminate.mock.calls.length
    await owner.close()
    expect(worker.terminate).toHaveBeenCalledTimes(attempts + 1)
    const requests = worker.postMessage.mock.calls.length
    worker.emit('message', { type: 'checked', id: 2 })
    expect(auto()).toBe(1000)
    expect(worker.postMessage).toHaveBeenCalledTimes(requests)
  }
)

it('keeps auto-checkpointing when worker construction or NOOP support is unavailable', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const { writer } = setup()
  const factory = vi.fn(() => {
    throw new Error('spawn failed')
  })
  const failed = new JournalCheckpointOwner(writer, ':memory:', { factory })
  owners.push(failed)
  expect(writer.pragma('wal_autocheckpoint', { simple: true })).toBe(1000)
  const prepare = writer.prepare.bind(writer)
  vi.spyOn(writer, 'prepare').mockImplementation((sql) =>
    prepare(sql.includes('sqlite_version') ? "SELECT '3.50.0' AS version" : sql)
  )
  const unsupportedFactory = vi.fn(() => new CheckpointThread())
  const unsupported = new JournalCheckpointOwner(writer, ':memory:', {
    factory: unsupportedFactory
  })
  owners.push(unsupported)
  expect(unsupportedFactory).not.toHaveBeenCalled()
})

it.each(['reject', 'throw'])(
  'retains failed retirement ownership and retries the real operation after %s',
  async (failure) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { worker, owner, auto } = setup()
    worker.terminate.mockImplementationOnce(() => {
      if (failure === 'throw') {
        throw new Error('retirement failed')
      }
      return Promise.reject(new Error('retirement failed'))
    })
    await expect(owner.close()).rejects.toThrow('retirement failed')
    expect(auto()).toBe(1000)
    const attempts = worker.terminate.mock.calls.length
    worker.emit('message', { type: 'checked', id: 1 })
    await owner.close()
    expect(worker.terminate).toHaveBeenCalledTimes(attempts + 1)
  }
)

it('retains failed restoration debt for a legitimate committed-write and close retry', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {
    throw new Error('log failed')
  })
  const { worker, writer, owner, auto } = setup()
  const pragma = writer.pragma.bind(writer)
  const restore = vi.spyOn(writer, 'pragma').mockImplementation((sql, options) => {
    if (sql === 'wal_autocheckpoint = 1000') {
      throw new Error('restore failed')
    }
    return pragma(sql, options)
  })
  worker.emit('error', new Error('worker failed'))
  expect(() => owner.afterCommit()).not.toThrow()
  await expect(owner.close()).rejects.toThrow('restore failed')
  restore.mockRestore()
  owner.afterCommit()
  expect(auto()).toBe(1000)
  await owner.close()
})
