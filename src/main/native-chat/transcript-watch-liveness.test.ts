import { EventEmitter } from 'node:events'
import type { FSWatcher } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { appendFile, mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { watchers, watchCallbacks, watchMock, watchState } = vi.hoisted(() => ({
  watchers: [] as (EventEmitter & {
    close: ReturnType<typeof vi.fn>
    unref: ReturnType<typeof vi.fn>
  })[],
  watchCallbacks: [] as ((event: string, filename: string | Buffer | null) => void)[],
  watchMock: vi.fn(),
  watchState: { error: null as Error | null }
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  watchMock.mockImplementation((_path, callback) => {
    if (watchState.error) {
      throw watchState.error
    }
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() })
    watchers.push(watcher)
    watchCallbacks.push(callback)
    return watcher as unknown as FSWatcher
  })
  return { ...actual, watch: watchMock }
})

import { subscribeNativeChatTranscript } from './transcript-watch'

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  watchers.length = 0
  watchCallbacks.length = 0
  watchMock.mockClear()
  watchState.error = null
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempFile(initial: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-watch-liveness-'))
  roots.push(root)
  const filePath = join(root, 'transcript.jsonl')
  await writeFile(filePath, initial)
  return filePath
}

function claudeLine(uuid: string, role: 'user' | 'assistant', text: string): string {
  return `${JSON.stringify({
    type: role,
    uuid,
    timestamp: '2026-06-01T10:00:00.000Z',
    message: { role, content: role === 'user' ? text : [{ type: 'text', text }] }
  })}\n`
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('native chat transcript watcher liveness', () => {
  it('reconciles without a native watcher when fs.watch cannot bind', async () => {
    watchState.error = new Error('ENOSYS')
    const filePath = await tempFile(claudeLine('seed', 'user', 'hello'))
    const snapshots = vi.fn()
    const appends = vi.fn()
    const subscription = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'session',
      filePath,
      onInitialSnapshot: snapshots,
      onAppend: appends,
      debounceMs: 0,
      reconciliationIntervalMs: 20
    })
    await waitFor(() => snapshots.mock.calls.length === 1)

    await appendFile(filePath, claudeLine('poll-only', 'assistant', 'recovered'))
    await waitFor(() => appends.mock.calls.flat(2).some((message) => message.id === 'poll-only'))

    subscription.unsubscribe()
    expect(subscription.watching).toBe(true)
    expect(watchers).toHaveLength(0)
    expect(watchMock.mock.calls.length).toBeGreaterThan(1)
  })

  it('keeps polling readable transcripts while native watcher rebind fails', async () => {
    const filePath = await tempFile(claudeLine('seed', 'user', 'hello'))
    const snapshots = vi.fn()
    const appends = vi.fn()
    const subscription = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'session',
      filePath,
      onInitialSnapshot: snapshots,
      onAppend: appends,
      debounceMs: 0,
      reconciliationIntervalMs: 20
    })
    await waitFor(() => snapshots.mock.calls.length === 1)

    watchState.error = new Error('EPERM')
    watchers[0]!.emit('error', watchState.error)
    await appendFile(filePath, claudeLine('failed-rebind', 'assistant', 'still tailed'))
    await waitFor(
      () =>
        appends.mock.calls.flat(2).some((message) => message.id === 'failed-rebind') &&
        watchMock.mock.calls.length > 1
    )

    subscription.unsubscribe()
    expect(watchers[0]!.close).toHaveBeenCalledOnce()
    expect(watchMock.mock.calls.length).toBeGreaterThan(1)
  })

  it('reconciles an append when fs.watch omits the callback', async () => {
    const filePath = await tempFile(claudeLine('seed', 'user', 'hello'))
    const snapshots = vi.fn()
    const appends = vi.fn()
    const subscription = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'session',
      filePath,
      onInitialSnapshot: snapshots,
      onAppend: appends,
      debounceMs: 0,
      reconciliationIntervalMs: 20
    })
    await waitFor(() => snapshots.mock.calls.length === 1)

    await appendFile(filePath, claudeLine('missed-event', 'assistant', 'recovered'))
    // The mocked watcher never invokes watchCallbacks[0], reproducing a silent
    // missed/coalesced host event while the file itself remains valid.
    await waitFor(() => appends.mock.calls.flat(2).some((message) => message.id === 'missed-event'))

    subscription.unsubscribe()
    expect(watchCallbacks).toHaveLength(1)
  })

  it('replaces a same-size prefix rewrite with an unchanged trailing boundary', async () => {
    const prefixBefore = claudeLine('prefix-old', 'user', 'before')
    const prefixAfter = claudeLine('prefix-new', 'user', 'after!')
    const stableTail = claudeLine('stable-tail', 'assistant', 'x'.repeat(200))
    expect(Buffer.byteLength(prefixAfter)).toBe(Buffer.byteLength(prefixBefore))
    const filePath = await tempFile(prefixBefore + stableTail)
    const snapshots = vi.fn()
    const replacements = vi.fn()
    const subscription = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'session',
      filePath,
      initialLimit: 40,
      onInitialSnapshot: snapshots,
      onReplace: replacements,
      onAppend: () => {},
      debounceMs: 0,
      reconciliationIntervalMs: 20
    })
    await waitFor(() => snapshots.mock.calls.length === 1)

    await writeFile(filePath, prefixAfter + stableTail)
    const future = new Date(Date.now() + 10_000)
    await utimes(filePath, future, future)
    await waitFor(() =>
      replacements.mock.calls.flat(2).some((message) => message.id === 'prefix-new')
    )

    subscription.unsubscribe()
    expect(replacements).toHaveBeenCalledOnce()
  })

  it('rebinds the native watcher after silent parent-directory replacement', async () => {
    const filePath = await tempFile(claudeLine('old-file', 'user', 'before'))
    const root = dirname(filePath)
    const oldRoot = `${root}.old`
    roots.push(oldRoot)
    const snapshots = vi.fn()
    const replacements = vi.fn()
    const appends = vi.fn()
    const subscription = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'session',
      filePath,
      initialLimit: 40,
      onInitialSnapshot: snapshots,
      onReplace: replacements,
      onAppend: appends,
      debounceMs: 0,
      reconciliationIntervalMs: 20
    })
    await waitFor(() => snapshots.mock.calls.length === 1)

    await rename(root, oldRoot)
    await mkdir(root)
    await writeFile(filePath, claudeLine('new-file', 'user', 'after'))
    await waitFor(() => replacements.mock.calls.length === 1 && watchers.length === 2)
    await appendFile(filePath, claudeLine('new-followup', 'assistant', 'event-driven'))
    watchCallbacks[1]!('change', 'transcript.jsonl')
    await waitFor(() => appends.mock.calls.flat(2).some((message) => message.id === 'new-followup'))

    subscription.unsubscribe()
    expect(watchers[0]!.close).toHaveBeenCalledOnce()
    expect(watchers[1]!.close).toHaveBeenCalledOnce()
  })

  it('drains within the max wait while matching events remain sustained', async () => {
    const filePath = await tempFile(claudeLine('seed', 'user', 'hello'))
    const snapshots = vi.fn()
    const appends = vi.fn()
    const subscription = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'session',
      filePath,
      onInitialSnapshot: snapshots,
      onAppend: appends,
      debounceMs: 40,
      reconciliationIntervalMs: 10_000
    })
    await waitFor(() => snapshots.mock.calls.length === 1)
    await appendFile(filePath, claudeLine('sustained-events', 'assistant', 'bounded'))

    for (let index = 0; index < 20; index += 1) {
      watchCallbacks[0]!('change', 'transcript.jsonl')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect(appends.mock.calls.flat(2).some((message) => message.id === 'sustained-events')).toBe(
      true
    )
    subscription.unsubscribe()
  })

  it('clears every timer and cannot rebind after unsubscribe', async () => {
    vi.useFakeTimers()
    const filePath = await tempFile('')
    const snapshots = vi.fn()
    const appends = vi.fn()
    const subscription = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'session',
      filePath,
      onInitialSnapshot: snapshots,
      onAppend: appends,
      reconciliationIntervalMs: 20
    })

    subscription.unsubscribe()
    expect(watchers[0]!.unref).toHaveBeenCalledOnce()
    expect(watchers[0]!.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)

    watchCallbacks[0]!('change', 'transcript.jsonl')
    watchers[0]!.emit('error', new Error('late watcher error'))
    await vi.advanceTimersByTimeAsync(10_000)

    expect(watchMock).toHaveBeenCalledOnce()
    expect(snapshots).not.toHaveBeenCalled()
    expect(appends).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
