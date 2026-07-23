import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as TranscriptTailReader from './transcript-tail-reader'

const { tailRead, tailReadStarted, rejectTailRead } = vi.hoisted(() => {
  let markStarted = (): void => {}
  let reject = (_error: Error): void => {}
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const read = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise
  })
  return {
    tailRead: vi.fn(() => {
      markStarted()
      return read
    }),
    tailReadStarted: started,
    rejectTailRead: reject
  }
})

vi.mock('./transcript-tail-reader', async () => {
  const actual = await vi.importActual<typeof TranscriptTailReader>('./transcript-tail-reader')
  return { ...actual, readNativeChatTranscriptTailFile: tailRead }
})

import { getActiveNativeChatWatcherCount, subscribeNativeChatTranscript } from './transcript-watch'

let root: string | null = null

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

describe('native chat transcript watcher unsubscribe race', () => {
  it('does not emit an initial read error after unsubscribe', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-native-chat-unsubscribe-race-'))
    const filePath = join(root, 'transcript.jsonl')
    await writeFile(filePath, '{}\n')
    const snapshots = vi.fn()
    const activeBefore = getActiveNativeChatWatcherCount()
    const subscription = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'session',
      filePath,
      initialLimit: 40,
      onInitialSnapshot: snapshots,
      onAppend: () => {},
      debounceMs: 0,
      reconciliationIntervalMs: 10_000
    })
    await tailReadStarted

    subscription.unsubscribe()
    rejectTailRead(new Error('late read failure'))
    await new Promise((resolve) => setImmediate(resolve))

    expect(snapshots).not.toHaveBeenCalled()
    expect(getActiveNativeChatWatcherCount()).toBe(activeBefore)
  })
})
