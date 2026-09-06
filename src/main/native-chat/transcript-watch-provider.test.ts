import { describe, expect, it, vi } from 'vitest'
import type { TranscriptFileSource } from './transcript-file-source'
import { getActiveNativeChatWatcherCount, subscribeNativeChatTranscript } from './transcript-watch'

describe('provider-backed native-chat transcript watcher', () => {
  it('recovers after provider loss and stops all reconciliation on unsubscribe', async () => {
    let content = Buffer.from(claudeLine('u-1', 'user', 'hello'))
    let version = 1
    let connected = true
    let statCalls = 0
    let closeCalls = 0
    const source: TranscriptFileSource = {
      supportsNativeWatch: false,
      async stat() {
        statCalls += 1
        if (!connected) {
          throw new Error('provider unavailable')
        }
        return {
          identity: 'remote:1',
          size: content.byteLength,
          mtimeMs: version,
          ctimeMs: version
        }
      },
      async open() {
        if (!connected) {
          throw new Error('provider unavailable')
        }
        const snapshot = content
        return {
          async read(offset, length) {
            if (!connected) {
              throw new Error('provider unavailable')
            }
            return snapshot.subarray(offset, offset + length)
          },
          async close() {
            closeCalls += 1
          }
        }
      }
    }
    const snapshots = vi.fn()
    const appends = vi.fn()
    const activeBefore = getActiveNativeChatWatcherCount()
    const subscription = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'session-1',
      filePath: '/remote/session.jsonl',
      fileSource: source,
      initialLimit: 40,
      onInitialSnapshot: snapshots,
      onAppend: appends,
      debounceMs: 0,
      reconciliationIntervalMs: 10
    })

    await vi.waitFor(() =>
      expect(snapshots.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ id: 'u-1' })])
    )
    connected = false
    await vi.waitFor(() => expect(statCalls).toBeGreaterThan(5))
    expect(appends).not.toHaveBeenCalled()

    content = Buffer.from(
      claudeLine('u-1', 'user', 'hello') + claudeLine('a-1', 'assistant', 'reconnected')
    )
    version += 1
    connected = true
    await vi.waitFor(() =>
      expect(
        appends.mock.calls.some((call) => call[0]?.some((message) => message.id === 'a-1'))
      ).toBe(true)
    )

    subscription.unsubscribe()
    const callsAfterUnsubscribe = statCalls
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(statCalls).toBe(callsAfterUnsubscribe)
    expect(closeCalls).toBeGreaterThan(0)
    expect(getActiveNativeChatWatcherCount()).toBe(activeBefore)
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
