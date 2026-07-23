import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as TranscriptTailReader from './transcript-tail-reader'

const { tailRead } = vi.hoisted(() => ({ tailRead: vi.fn() }))

vi.mock('./transcript-tail-reader', async () => {
  const actual = await vi.importActual<typeof TranscriptTailReader>('./transcript-tail-reader')
  return { ...actual, readNativeChatTranscriptTailFile: tailRead }
})

import { nativeChatTranscriptReadAdmission } from './transcript-read-admission'
import { getActiveNativeChatWatcherCount, subscribeNativeChatTranscript } from './transcript-watch'
import type { NativeChatTranscriptSubscription } from './transcript-watch-contract'

let root: string | null = null
const subscriptions: NativeChatTranscriptSubscription[] = []

afterEach(async () => {
  for (const subscription of subscriptions.splice(0)) {
    subscription.unsubscribe()
  }
  await vi.waitFor(() => expect(nativeChatTranscriptReadAdmission.activeCount).toBe(0))
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

describe('native chat transcript watcher drain admission', () => {
  it('removes a queued drain immediately when its watcher unsubscribes', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-native-chat-drain-admission-'))
    const filePath = join(root, 'transcript.jsonl')
    await writeFile(filePath, '{}\n')
    let finishReads!: () => void
    const readGate = new Promise<{
      messages: never[]
      consumedTo: number
      hasMore: boolean
      beforeOffset: number
    }>((resolve) => {
      finishReads = () => resolve({ messages: [], consumedTo: 3, hasMore: false, beforeOffset: 0 })
    })
    tailRead.mockReturnValue(readGate)
    const activeBefore = getActiveNativeChatWatcherCount()

    for (let index = 0; index < 3; index++) {
      subscriptions.push(
        await subscribeNativeChatTranscript({
          agent: 'claude',
          sessionId: `session-${index}`,
          filePath,
          initialLimit: 40,
          onInitialSnapshot: () => {},
          onAppend: () => {},
          debounceMs: 0,
          reconciliationIntervalMs: 10_000
        })
      )
    }
    await vi.waitFor(() => {
      expect(nativeChatTranscriptReadAdmission.activeCount).toBe(2)
      expect(nativeChatTranscriptReadAdmission.queuedCount).toBe(1)
    })

    subscriptions.pop()?.unsubscribe()

    await vi.waitFor(() => expect(nativeChatTranscriptReadAdmission.queuedCount).toBe(0))
    expect(getActiveNativeChatWatcherCount()).toBe(activeBefore + 2)

    finishReads()
    await vi.waitFor(() => expect(nativeChatTranscriptReadAdmission.activeCount).toBe(0))
  })
})
