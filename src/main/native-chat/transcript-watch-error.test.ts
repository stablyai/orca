import { EventEmitter } from 'node:events'
import type { FSWatcher } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as TranscriptTailReader from './transcript-tail-reader'

const { tailReaderState, watchers, watchCallbacks, watchMock } = vi.hoisted(() => ({
  tailReaderState: { failure: null as Error | null },
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

vi.mock('./transcript-tail-reader', async () => {
  const actual = await vi.importActual<typeof TranscriptTailReader>('./transcript-tail-reader')
  return {
    ...actual,
    readNativeChatTranscriptTailFile: (
      ...args: Parameters<typeof actual.readNativeChatTranscriptTailFile>
    ) => {
      if (tailReaderState.failure) {
        return Promise.reject(tailReaderState.failure)
      }
      return actual.readNativeChatTranscriptTailFile(...args)
    }
  }
})

import { subscribeNativeChatTranscript } from './transcript-watch'

const roots: string[] = []

afterEach(async () => {
  watchers.length = 0
  watchCallbacks.length = 0
  watchMock.mockClear()
  tailReaderState.failure = null
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('native chat transcript watcher errors', () => {
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

  it('still wins with a real initial snapshot once the transcript becomes readable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-initial-recover-'))
    roots.push(root)
    const filePath = join(root, 'transcript.jsonl')
    await writeFile(filePath, '')
    tailReaderState.failure = new Error('deterministic read failure')
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

    // Write content before read recovery: an intervening empty success legitimately consumes initialDrain.
    await writeFile(filePath, claudeLine('u-recovered', 'user', 'back'))
    tailReaderState.failure = null
    watchCallbacks[0]!('change', 'transcript.jsonl')
    await vi.waitFor(() => expect(onInitialSnapshot).toHaveBeenCalledTimes(2))
    expect(onInitialSnapshot.mock.calls[1]![0]).toEqual([
      expect.objectContaining({ id: 'u-recovered' })
    ])

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
