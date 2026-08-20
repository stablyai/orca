import { EventEmitter } from 'node:events'
import type { FSWatcher } from 'node:fs'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { watchers, watchCallbacks, watchMock, unreadablePaths } = vi.hoisted(() => ({
  watchers: [] as (EventEmitter & { close: ReturnType<typeof vi.fn> })[],
  watchCallbacks: [] as ((event: string, filename: string | Buffer | null) => void)[],
  watchMock: vi.fn(),
  /** Paths whose reads keep failing, see refuseTranscriptReads. */
  unreadablePaths: new Set<string>()
}))

/**
 * Why the refusal is injected and not staged on disk: the POSIX way to force a
 * persistent read error is a directory at the transcript path, and Windows opens a
 * directory happily, so the reader sees an empty transcript instead. The behaviour
 * under test — one error snapshot, no retry spam, and a later recovery that still
 * wins — is platform-independent, so the failing read is too.
 */
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  const refuseIfMarked = (path: unknown): void => {
    if (typeof path === 'string' && unreadablePaths.has(path)) {
      throw Object.assign(new Error(`EIO: i/o error, read '${path}'`), { code: 'EIO' })
    }
  }
  // Only the open: stat must still succeed, or the watcher never installs and
  // degrades to resolve-polling instead of draining — the same shape a directory
  // at the path gives POSIX, where stat works and the read is what fails.
  return {
    ...actual,
    open: async (path: Parameters<typeof actual.open>[0], ...rest: unknown[]) => {
      refuseIfMarked(path)
      return actual.open(path, ...(rest as []))
    }
  }
})

/** Marks a real, existing transcript as unreadable until `restore` is called. */
function refuseTranscriptReads(filePath: string): { restore: () => void } {
  unreadablePaths.add(filePath)
  return { restore: () => unreadablePaths.delete(filePath) }
}

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
  unreadablePaths.clear()
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
    // A real transcript whose reads keep failing: it exists (so install does not
    // defer to the not-yet-flushed resolve poll, #8401) but every tail read throws —
    // a persistent read error, not a missing file.
    const filePath = join(root, 'transcript.jsonl')
    await writeFile(filePath, claudeLine('u-unreadable', 'user', 'hidden'))
    refuseTranscriptReads(filePath)
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
    // Same refused-read setup as above; the error frame must not be terminal once
    // the transcript becomes readable again.
    const filePath = join(root, 'transcript.jsonl')
    await writeFile(filePath, claudeLine('u-recovered', 'user', 'back'))
    const readable = refuseTranscriptReads(filePath)
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
    readable.restore()
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
