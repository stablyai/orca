import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { handlers, authorize } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  authorize: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler)
  }
}))
vi.mock('./filesystem-auth', () => ({ resolveAuthorizedPath: authorize }))
import {
  closeAllLocalLogTailWatchers,
  getActiveLocalLogTailWatcherCount,
  registerLocalLogTailHandlers
} from './local-log-tail'

class Sender extends EventEmitter {
  dead = false
  send = vi.fn()
  constructor(readonly id: number) {
    super()
  }
  isDestroyed() {
    return this.dead
  }
  destroy() {
    this.dead = true
    this.emit('destroyed')
  }
}
let directory = ''
let filePath = ''
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-log-admission-test-'))
  filePath = join(directory, 'fixture.log')
  await writeFile(filePath, 'test\n')
  authorize.mockReset().mockResolvedValue(filePath)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization is mocked; the handler never reads Store in this isolated fixture.
  registerLocalLogTailHandlers({} as never)
})
afterEach(async () => {
  closeAllLocalLogTailWatchers()
  await rm(directory, { force: true, recursive: true })
})
function start(sender: Sender, subscriptionId = 'tail') {
  return handlers.get('fs:startLocalLogTail')!({ sender }, { filePath, subscriptionId })
}
function deferAuthorization() {
  let resolve!: (path: string) => void
  let reject!: (error: Error) => void
  const promise = new Promise<string>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  authorize.mockReturnValueOnce(promise)
  return { resolve: (path = filePath) => resolve(path), reject: () => reject(new Error('denied')) }
}

it('does not install a watcher after its sender is destroyed during authorization', async () => {
  const sender = new Sender(1)
  const admission = deferAuthorization()
  const pending = start(sender)
  sender.destroy()
  admission.resolve()
  await pending
  expect(getActiveLocalLogTailWatcherCount()).toBe(0)
  expect(sender.listenerCount('destroyed')).toBe(0)
})
it('does not revive an existing subscription while a replacement is authorizing at destruction', async () => {
  const sender = new Sender(2)
  await start(sender)
  const admission = deferAuthorization()
  const pending = start(sender)
  sender.destroy()
  expect(getActiveLocalLogTailWatcherCount()).toBe(0)
  admission.resolve()
  await pending
  expect(getActiveLocalLogTailWatcherCount()).toBe(0)
  expect(sender.listenerCount('destroyed')).toBe(0)
})
it('rejects both overlapping same-ID admissions after renderer destruction', async () => {
  const sender = new Sender(3)
  const first = deferAuthorization()
  const pendingFirst = start(sender)
  const second = deferAuthorization()
  const pendingSecond = start(sender)
  sender.destroy()
  second.resolve()
  await pendingSecond
  first.resolve()
  await pendingFirst
  expect(getActiveLocalLogTailWatcherCount()).toBe(0)
  expect(sender.listenerCount('destroyed')).toBe(0)
})
it('replaces a live same-ID subscription and keeps one sender cleanup listener', async () => {
  const sender = new Sender(4)
  await start(sender)
  await start(sender)
  expect(getActiveLocalLogTailWatcherCount()).toBe(1)
  expect(sender.listenerCount('destroyed')).toBe(1)
  sender.destroy()
  expect(getActiveLocalLogTailWatcherCount()).toBe(0)
})
it('preserves a live subscription when replacement authorization fails', async () => {
  const sender = new Sender(5)
  await start(sender)
  const admission = deferAuthorization()
  const pending = Promise.resolve(start(sender))
  const rejection = expect(pending).rejects.toThrow('denied')
  admission.reject()
  await rejection
  expect(getActiveLocalLogTailWatcherCount()).toBe(1)
  sender.destroy()
  expect(getActiveLocalLogTailWatcherCount()).toBe(0)
})
it('a failed older admission cannot remove a newer successful same-ID watch', async () => {
  const sender = new Sender(6)
  const admission = deferAuthorization()
  const pending = Promise.resolve(start(sender))
  const rejection = expect(pending).rejects.toThrow('denied')
  await start(sender)
  admission.reject()
  await rejection
  expect(getActiveLocalLogTailWatcherCount()).toBe(1)
  sender.destroy()
  expect(getActiveLocalLogTailWatcherCount()).toBe(0)
})

it.each(['render-process-gone', 'did-navigate'])(
  'releases installed and pending watches on %s and permits a new document owner',
  async (event) => {
    const sender = new Sender(7)
    await start(sender, 'installed')
    const admission = deferAuthorization()
    const pending = start(sender, 'pending')
    sender.emit(event)
    expect(getActiveLocalLogTailWatcherCount()).toBe(0)
    expect(sender.listenerCount('destroyed')).toBe(0)
    await start(sender, 'pending')
    admission.resolve()
    await pending
    expect(getActiveLocalLogTailWatcherCount()).toBe(1)
    expect(sender.listenerCount('destroyed')).toBe(1)
    sender.destroy()
    expect(getActiveLocalLogTailWatcherCount()).toBe(0)
  }
)

it('keeps live watches for same-document and canceled navigation', async () => {
  const sender = new Sender(8)
  await start(sender)
  sender.emit('did-start-navigation', {}, 'https://blocked.example', false, true)
  sender.emit('did-navigate-in-page', {}, 'app://index.html#route', true)
  expect(getActiveLocalLogTailWatcherCount()).toBe(1)
})

it('shares lifecycle listeners and releases them when the last watch stops', async () => {
  const sender = new Sender(9)
  await Promise.all(Array.from({ length: 20 }, (_, index) => start(sender, `tail-${index}`)))
  for (const event of ['destroyed', 'render-process-gone', 'did-navigate']) {
    expect(sender.listenerCount(event)).toBe(1)
  }
  for (let index = 0; index < 20; index++) {
    handlers.get('fs:stopLocalLogTail')!({ sender }, { subscriptionId: `tail-${index}` })
  }
  expect(getActiveLocalLogTailWatcherCount()).toBe(0)
  for (const event of ['destroyed', 'render-process-gone', 'did-navigate']) {
    expect(sender.listenerCount(event)).toBe(0)
  }
})

it('explicit stop invalidates pending authorization without retaining idle listeners', async () => {
  const sender = new Sender(10)
  const admission = deferAuthorization()
  const pending = start(sender)
  handlers.get('fs:stopLocalLogTail')!({ sender }, { subscriptionId: 'tail' })
  expect(sender.listenerCount('destroyed')).toBe(0)
  admission.resolve()
  await pending
  expect(getActiveLocalLogTailWatcherCount()).toBe(0)
})

it('late success from an older same-ID request preserves the newer installed watch', async () => {
  const sender = new Sender(11)
  const admission = deferAuthorization()
  const pending = start(sender)
  await start(sender)
  const listeners = sender.rawListeners('destroyed')
  admission.resolve(join(directory, 'retired-file-no-longer-exists.log'))
  await pending
  expect(getActiveLocalLogTailWatcherCount()).toBe(1)
  expect(sender.rawListeners('destroyed')).toEqual(listeners)
})

it('a failed initial authorization releases all lifecycle listeners', async () => {
  const sender = new Sender(12)
  authorize.mockRejectedValueOnce(new Error('denied'))
  await expect(start(sender)).rejects.toThrow('denied')
  expect(getActiveLocalLogTailWatcherCount()).toBe(0)
  for (const event of ['destroyed', 'render-process-gone', 'did-navigate']) {
    expect(sender.listenerCount(event)).toBe(0)
  }
})

it('close-all invalidates pending admission and leaves replacement ownership intact', async () => {
  const sender = new Sender(13)
  const admission = deferAuthorization()
  const pending = start(sender)
  closeAllLocalLogTailWatchers()
  await start(sender)
  admission.resolve()
  await pending
  expect(getActiveLocalLogTailWatcherCount()).toBe(1)
  expect(sender.listenerCount('destroyed')).toBe(1)
})

it('releases a failed native watcher installation after authorization', async () => {
  const sender = new Sender(14)
  authorize.mockResolvedValueOnce(join(directory, 'missing.log'))
  await expect(start(sender)).rejects.toThrow()
  expect(getActiveLocalLogTailWatcherCount()).toBe(0)
  for (const event of ['destroyed', 'render-process-gone', 'did-navigate']) {
    expect(sender.listenerCount(event)).toBe(0)
  }
})

it('does not accumulate watchers across twenty destroyed renderer owners', async () => {
  let authorizeNow!: (path: string) => void
  authorize.mockReturnValue(
    new Promise<string>((resolve) => {
      authorizeNow = resolve
    })
  )
  const senders = Array.from({ length: 20 }, (_, index) => new Sender(index + 20))
  const pending = senders.map((sender) => start(sender))
  for (const sender of senders) {
    sender.destroy()
  }
  authorizeNow(filePath)
  await Promise.all(pending)
  expect(getActiveLocalLogTailWatcherCount()).toBe(0)
  expect(senders.every((sender) => sender.listenerCount('destroyed') === 0)).toBe(true)
})
