import { EventEmitter } from 'node:events'
import type { FSWatcher } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { watchers, watchCallbacks, watchMock } = vi.hoisted(() => ({
  watchers: [] as (EventEmitter & { close: ReturnType<typeof vi.fn> })[],
  watchCallbacks: [] as ((event: string, filename: string | Buffer | null) => void)[],
  watchMock: vi.fn()
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  watchMock.mockImplementation((_path, callback) => {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() })
    watchers.push(watcher)
    watchCallbacks.push(callback)
    return watcher as unknown as FSWatcher
  })
  return { ...actual, watch: watchMock }
})

import { subscribeNativeChatTranscript } from './transcript-watch'

const roots: string[] = []

afterEach(async () => {
  watchers.length = 0
  watchCallbacks.length = 0
  watchMock.mockClear()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('native chat transcript watcher errors', () => {
  it('handles a watcher error and rebinds after the directory is readable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-watch-error-'))
    roots.push(root)
    const filePath = join(root, 'transcript.jsonl')
    await writeFile(filePath, '')
    const subscription = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'session',
      filePath,
      onAppend: () => {},
      debounceMs: 0
    })

    expect(() => watchers[0]!.emit('error', new Error('EPERM'))).not.toThrow()
    await vi.waitFor(() => expect(watchMock).toHaveBeenCalledTimes(2))

    subscription.unsubscribe()
    expect(watchers[0]!.close).toHaveBeenCalledOnce()
    expect(watchers[1]!.close).toHaveBeenCalledOnce()
  })

  it('keeps retrying after the old recovery window and tails a recreated directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-watch-gap-'))
    roots.push(root)
    const filePath = join(root, 'transcript.jsonl')
    await writeFile(filePath, '')
    const onInitialSnapshot = vi.fn()
    const onAppend = vi.fn()
    const subscription = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'session',
      filePath,
      onInitialSnapshot,
      onAppend,
      initialLimit: 40,
      debounceMs: 0
    })
    await vi.waitFor(() => expect(onInitialSnapshot).toHaveBeenCalledOnce())

    await rm(root, { recursive: true, force: true })
    watchers[0]!.emit('error', new Error('EPERM'))
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(watchMock).toHaveBeenCalledTimes(1)

    await mkdir(root, { recursive: true })
    await writeFile(filePath, claudeLine('u-recreated', 'user', 'back'))
    await vi.waitFor(() => expect(watchMock).toHaveBeenCalledTimes(2), { timeout: 2_000 })

    await appendFile(filePath, claudeLine('a-recreated', 'assistant', 'reply'))
    watchCallbacks[1]!('change', 'transcript.jsonl')
    await vi.waitFor(() =>
      expect(onAppend.mock.calls.flat(2)).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'a-recreated' })])
      )
    )

    subscription.unsubscribe()
    expect(watchers[1]!.close).toHaveBeenCalledOnce()
  })

  it('surfaces an error snapshot when the initial drain throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-initial-error-'))
    roots.push(root)
    // A directory sitting at the transcript path: it exists (so install does not
    // defer to the not-yet-flushed resolve poll, #8401) but every tail read
    // throws EISDIR — a persistent real read error, not a missing file.
    const filePath = join(root, 'transcript.jsonl')
    await mkdir(filePath)
    const onInitialSnapshot = vi.fn()
    const onAppend = vi.fn()
    const subscription = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'session',
      filePath,
      onInitialSnapshot,
      onAppend,
      initialLimit: 40,
      debounceMs: 0
    })
    expect(subscription.watching).toBe(true)

    await vi.waitFor(() =>
      expect(onInitialSnapshot).toHaveBeenCalledWith([], false, 0, 'Transcript unavailable')
    )
    // Surfaced once, not spammed by the capped rotation retry loop.
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(onInitialSnapshot).toHaveBeenCalledOnce()

    subscription.unsubscribe()
  })

  it('still wins with a real initial snapshot once the transcript becomes readable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-initial-recover-'))
    roots.push(root)
    // Same unreadable-directory setup as above; the error frame must not be
    // terminal once the path is replaced with a readable transcript.
    const filePath = join(root, 'transcript.jsonl')
    await mkdir(filePath)
    const onInitialSnapshot = vi.fn()
    const subscription = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'session',
      filePath,
      onInitialSnapshot,
      onAppend: () => {},
      initialLimit: 40,
      debounceMs: 0
    })
    await vi.waitFor(() =>
      expect(onInitialSnapshot).toHaveBeenCalledWith([], false, 0, 'Transcript unavailable')
    )

    // initialDrain stays true after the error, so a recovered read delivers the
    // real snapshot instead of stranding the client on the error frame.
    await rm(filePath, { recursive: true, force: true })
    await writeFile(filePath, claudeLine('u-recovered', 'user', 'back'))
    watchCallbacks[0]!('change', 'transcript.jsonl')
    await vi.waitFor(() =>
      expect(onInitialSnapshot.mock.calls.flat(2)).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'u-recovered' })])
      )
    )

    subscription.unsubscribe()
  })
})

function claudeLine(uuid: string, role: 'user' | 'assistant', text: string): string {
  return `${JSON.stringify({
    type: role,
    uuid,
    timestamp: '2026-06-01T10:00:00.000Z',
    message: { role, content: role === 'user' ? text : [{ type: 'text', text }] }
  })}\n`
}
