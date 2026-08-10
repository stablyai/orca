import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import type { SubscribeNativeChatTranscriptArgs } from './transcript-watch-contract'

const readSshNativeChatTranscript = vi.fn()

vi.mock('./ssh-transcript-host', () => ({
  readSshNativeChatTranscript: (...args: unknown[]) => readSshNativeChatTranscript(...args)
}))

const { subscribeSshNativeChatTranscript } = await import('./ssh-transcript-subscription')

function message(id: string): NativeChatMessage {
  return { id, role: 'assistant', blocks: [], timestamp: null, source: 'transcript' }
}

type SubscriptionCallbacks = Required<
  Pick<SubscribeNativeChatTranscriptArgs, 'onAppend' | 'onInitialSnapshot' | 'onReplace'>
>

function harness(): {
  onInitialSnapshot: ReturnType<typeof vi.fn<SubscriptionCallbacks['onInitialSnapshot']>>
  onReplace: ReturnType<typeof vi.fn<SubscriptionCallbacks['onReplace']>>
  onAppend: ReturnType<typeof vi.fn<SubscriptionCallbacks['onAppend']>>
} {
  return {
    onInitialSnapshot: vi.fn<SubscriptionCallbacks['onInitialSnapshot']>(),
    onReplace: vi.fn<SubscriptionCallbacks['onReplace']>(),
    onAppend: vi.fn<SubscriptionCallbacks['onAppend']>()
  }
}

function window(messages: NativeChatMessage[], fileSize: number): Record<string, unknown> {
  return { messages, hasMore: false, beforeOffset: 0, fileSize }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('subscribeSshNativeChatTranscript', () => {
  it('delivers the first window as a snapshot, which is what clears the loading state', async () => {
    readSshNativeChatTranscript.mockResolvedValue(window([message('a')], 10))
    const callbacks = harness()

    const subscription = subscribeSshNativeChatTranscript(
      'dev-box',
      { agent: 'claude', sessionId: 'abc', ...callbacks },
      { pollIntervalMs: 5 }
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(subscription.watching).toBe(true)
    expect(callbacks.onInitialSnapshot).toHaveBeenCalledWith(
      [message('a')],
      false,
      0,
      undefined,
      undefined
    )
    subscription.unsubscribe()
  })

  it('streams new turns as appends rather than re-shipping the window', async () => {
    readSshNativeChatTranscript
      .mockResolvedValueOnce(window([message('a')], 10))
      .mockResolvedValueOnce({ unchanged: true, fileSize: 10 })
      .mockResolvedValueOnce({ appended: [message('b')], fileSize: 20 })
    const callbacks = harness()

    const subscription = subscribeSshNativeChatTranscript(
      'dev-box',
      { agent: 'claude', sessionId: 'abc', ...callbacks },
      { pollIntervalMs: 5 }
    )
    await vi.advanceTimersByTimeAsync(12)

    expect(callbacks.onInitialSnapshot).toHaveBeenCalledTimes(1)
    expect(callbacks.onAppend).toHaveBeenCalledWith([message('b')], undefined)
    // A replacement would reset the renderer's window and drop paged-in history.
    expect(callbacks.onReplace).not.toHaveBeenCalled()
    subscription.unsubscribe()
  })

  it('replaces the window when the transcript was rotated under the cursor', async () => {
    readSshNativeChatTranscript
      .mockResolvedValueOnce(window([message('a')], 10))
      .mockResolvedValueOnce(window([message('fresh')], 4))
    const callbacks = harness()

    const subscription = subscribeSshNativeChatTranscript(
      'dev-box',
      { agent: 'claude', sessionId: 'abc', ...callbacks },
      { pollIntervalMs: 5 }
    )
    await vi.advanceTimersByTimeAsync(6)

    expect(callbacks.onReplace).toHaveBeenCalledWith([message('fresh')], false, 0, undefined)
    subscription.unsubscribe()
  })

  it('carries the cursor and the relay-resolved path forward on the next poll', async () => {
    readSshNativeChatTranscript.mockResolvedValue({
      ...window([message('a')], 10),
      filePath: '/home/dev/.claude/projects/repo/file.jsonl'
    })
    const callbacks = harness()

    const subscription = subscribeSshNativeChatTranscript(
      'dev-box',
      { agent: 'claude', sessionId: 'abc', ...callbacks },
      { pollIntervalMs: 5 }
    )
    await vi.advanceTimersByTimeAsync(6)

    expect(readSshNativeChatTranscript).toHaveBeenNthCalledWith(
      1,
      'dev-box',
      expect.not.objectContaining({ knownFileSize: expect.anything() }),
      expect.anything()
    )
    expect(readSshNativeChatTranscript).toHaveBeenNthCalledWith(
      2,
      'dev-box',
      expect.objectContaining({
        knownFileSize: 10,
        transcriptPath: '/home/dev/.claude/projects/repo/file.jsonl'
      }),
      expect.anything()
    )
    subscription.unsubscribe()
  })

  it('waits out a transcript the agent has not flushed yet instead of settling on an error', async () => {
    readSshNativeChatTranscript.mockResolvedValue({
      error: 'Transcript unavailable',
      notFound: true
    })
    const callbacks = harness()

    const subscription = subscribeSshNativeChatTranscript(
      'dev-box',
      { agent: 'claude', sessionId: 'abc', ...callbacks },
      { pollIntervalMs: 5, reportUnavailableAfterMs: 0 }
    )
    await vi.advanceTimersByTimeAsync(60)

    expect(callbacks.onInitialSnapshot).not.toHaveBeenCalled()
    subscription.unsubscribe()
  })

  it('reports an unreachable relay once, so a client cannot spin forever', async () => {
    readSshNativeChatTranscript.mockResolvedValue(null)
    const callbacks = harness()

    const subscription = subscribeSshNativeChatTranscript(
      'dev-box',
      { agent: 'claude', sessionId: 'abc', ...callbacks },
      { pollIntervalMs: 5, reportUnavailableAfterMs: 0 }
    )
    await vi.advanceTimersByTimeAsync(40)

    expect(callbacks.onInitialSnapshot).toHaveBeenCalledTimes(1)
    expect(callbacks.onInitialSnapshot).toHaveBeenCalledWith(
      [],
      false,
      0,
      'Transcript unavailable on the remote host'
    )
    subscription.unsubscribe()
  })

  it('keeps silent while a reconnect is still plausible', async () => {
    readSshNativeChatTranscript.mockResolvedValue(null)
    const callbacks = harness()

    const subscription = subscribeSshNativeChatTranscript(
      'dev-box',
      { agent: 'claude', sessionId: 'abc', ...callbacks },
      { pollIntervalMs: 5, reportUnavailableAfterMs: 30_000 }
    )
    await vi.advanceTimersByTimeAsync(60)

    expect(callbacks.onInitialSnapshot).not.toHaveBeenCalled()
    subscription.unsubscribe()
  })

  it('still delivers the transcript when the relay recovers after reporting', async () => {
    readSshNativeChatTranscript.mockResolvedValue(null)
    const callbacks = harness()

    const subscription = subscribeSshNativeChatTranscript(
      'dev-box',
      { agent: 'claude', sessionId: 'abc', ...callbacks },
      { pollIntervalMs: 5, reportUnavailableAfterMs: 0 }
    )
    await vi.advanceTimersByTimeAsync(20)
    readSshNativeChatTranscript.mockResolvedValue(window([message('a')], 10))
    await vi.advanceTimersByTimeAsync(10)

    expect(callbacks.onInitialSnapshot).toHaveBeenLastCalledWith(
      [message('a')],
      false,
      0,
      undefined,
      undefined
    )
    subscription.unsubscribe()
  })

  it('keeps polling through a dropped relay instead of settling the view on an error', async () => {
    readSshNativeChatTranscript
      .mockRejectedValueOnce(new Error('SSH relay is not ready'))
      .mockResolvedValue(window([message('a')], 10))
    const callbacks = harness()

    const subscription = subscribeSshNativeChatTranscript(
      'dev-box',
      { agent: 'claude', sessionId: 'abc', ...callbacks },
      { pollIntervalMs: 5 }
    )
    await vi.advanceTimersByTimeAsync(6)

    expect(callbacks.onInitialSnapshot).toHaveBeenCalledTimes(1)
    subscription.unsubscribe()
  })

  it('does not advance the cursor when a subscriber throws on the frame', async () => {
    readSshNativeChatTranscript.mockResolvedValue(window([message('a')], 10))
    const callbacks = harness()
    callbacks.onInitialSnapshot.mockImplementation(() => {
      throw new Error('renderer blew up')
    })

    const subscription = subscribeSshNativeChatTranscript(
      'dev-box',
      { agent: 'claude', sessionId: 'abc', ...callbacks },
      { pollIntervalMs: 5 }
    )
    await vi.advanceTimersByTimeAsync(6)

    expect(readSshNativeChatTranscript).toHaveBeenNthCalledWith(
      2,
      'dev-box',
      expect.not.objectContaining({ knownFileSize: expect.anything() }),
      expect.anything()
    )
    subscription.unsubscribe()
  })

  it('retries the initial snapshot when the subscriber throws on the first frame', async () => {
    // Flipping snapshotDelivered before the callback would route the retry to
    // onReplace, leave the client with no snapshot, and mute the silence report.
    readSshNativeChatTranscript.mockResolvedValue(window([message('a')], 10))
    const callbacks = harness()
    callbacks.onInitialSnapshot.mockImplementationOnce(() => {
      throw new Error('renderer not mounted')
    })

    const subscription = subscribeSshNativeChatTranscript(
      'dev-box',
      { agent: 'claude', sessionId: 'abc', ...callbacks },
      { pollIntervalMs: 5 }
    )
    // Two polls: the throwing first frame, then the retry that must land on the
    // same branch. A third would legitimately be a replacement.
    await vi.advanceTimersByTimeAsync(6)

    expect(callbacks.onInitialSnapshot).toHaveBeenCalledTimes(2)
    expect(callbacks.onReplace).not.toHaveBeenCalled()
    subscription.unsubscribe()
  })

  it('does not blame the remote host when a subscriber throws', async () => {
    readSshNativeChatTranscript.mockResolvedValue(window([message('a')], 10))
    const callbacks = harness()
    callbacks.onInitialSnapshot.mockImplementation(() => {
      throw new Error('renderer blew up')
    })

    const subscription = subscribeSshNativeChatTranscript(
      'dev-box',
      { agent: 'claude', sessionId: 'abc', ...callbacks },
      { pollIntervalMs: 5, reportUnavailableAfterMs: 0 }
    )
    await vi.advanceTimersByTimeAsync(40)

    expect(callbacks.onInitialSnapshot).not.toHaveBeenCalledWith(
      [],
      false,
      0,
      'Transcript unavailable on the remote host'
    )
    subscription.unsubscribe()
  })

  it('carries the file generation forward so a same-length rewrite is caught', async () => {
    readSshNativeChatTranscript.mockResolvedValue({
      ...window([message('a')], 10),
      generation: '1:2:3'
    })
    const callbacks = harness()

    const subscription = subscribeSshNativeChatTranscript(
      'dev-box',
      { agent: 'claude', sessionId: 'abc', ...callbacks },
      { pollIntervalMs: 5 }
    )
    await vi.advanceTimersByTimeAsync(6)

    expect(readSshNativeChatTranscript).toHaveBeenNthCalledWith(
      2,
      'dev-box',
      expect.objectContaining({ generation: '1:2:3' }),
      expect.anything()
    )
    subscription.unsubscribe()
  })

  it('does not start polling when setup was already aborted', async () => {
    readSshNativeChatTranscript.mockResolvedValue(window([message('a')], 10))
    const callbacks = harness()
    const controller = new AbortController()
    controller.abort()

    const subscription = subscribeSshNativeChatTranscript(
      'dev-box',
      { agent: 'claude', sessionId: 'abc', ...callbacks },
      { pollIntervalMs: 5, signal: controller.signal }
    )
    await vi.advanceTimersByTimeAsync(20)

    expect(subscription.watching).toBe(false)
    expect(readSshNativeChatTranscript).not.toHaveBeenCalled()
  })

  it('stops polling when the setup signal aborts later', async () => {
    readSshNativeChatTranscript.mockResolvedValue({ unchanged: true, fileSize: 10 })
    const callbacks = harness()
    const controller = new AbortController()

    const subscription = subscribeSshNativeChatTranscript(
      'dev-box',
      { agent: 'claude', sessionId: 'abc', ...callbacks },
      { pollIntervalMs: 5, signal: controller.signal }
    )
    await vi.advanceTimersByTimeAsync(6)
    controller.abort()
    const callsAtAbort = readSshNativeChatTranscript.mock.calls.length
    await vi.advanceTimersByTimeAsync(50)

    expect(readSshNativeChatTranscript).toHaveBeenCalledTimes(callsAtAbort)
    subscription.unsubscribe()
  })

  it('keeps polling when the unavailable frame itself throws', async () => {
    // The report is emitted from the transport-failure path; a throw there used
    // to escape before schedule() and kill the loop for good.
    readSshNativeChatTranscript.mockRejectedValue(new Error('SSH relay is not ready'))
    const callbacks = harness()
    callbacks.onInitialSnapshot.mockImplementation(() => {
      throw new Error('renderer blew up')
    })

    const subscription = subscribeSshNativeChatTranscript(
      'dev-box',
      { agent: 'claude', sessionId: 'abc', ...callbacks },
      { pollIntervalMs: 5, reportUnavailableAfterMs: 0 }
    )
    await vi.advanceTimersByTimeAsync(30)
    const callsAfterThrow = readSshNativeChatTranscript.mock.calls.length
    await vi.advanceTimersByTimeAsync(20)

    expect(readSshNativeChatTranscript.mock.calls.length).toBeGreaterThan(callsAfterThrow)
    subscription.unsubscribe()
  })

  it('offers the unavailable frame again when the subscriber threw on it', async () => {
    readSshNativeChatTranscript.mockRejectedValue(new Error('SSH relay is not ready'))
    const callbacks = harness()
    callbacks.onInitialSnapshot.mockImplementationOnce(() => {
      throw new Error('renderer not mounted')
    })

    const subscription = subscribeSshNativeChatTranscript(
      'dev-box',
      { agent: 'claude', sessionId: 'abc', ...callbacks },
      { pollIntervalMs: 5, reportUnavailableAfterMs: 0 }
    )
    await vi.advanceTimersByTimeAsync(20)

    expect(callbacks.onInitialSnapshot.mock.calls.length).toBeGreaterThan(1)
    expect(callbacks.onInitialSnapshot).toHaveBeenLastCalledWith(
      [],
      false,
      0,
      'Transcript unavailable on the remote host'
    )
    subscription.unsubscribe()
  })

  it('backs off instead of hammering the relay when every frame throws', async () => {
    // Production cadence: resetting the backoff before the callback pinned a
    // permanently throwing subscriber at one full remote window per second.
    readSshNativeChatTranscript.mockResolvedValue(window([message('a')], 10))
    const callbacks = harness()
    callbacks.onInitialSnapshot.mockImplementation(() => {
      throw new Error('renderer blew up')
    })

    const subscription = subscribeSshNativeChatTranscript('dev-box', {
      agent: 'claude',
      sessionId: 'abc',
      ...callbacks
    })
    await vi.advanceTimersByTimeAsync(30_000)

    // 1s, 2s, 4s, 5s, 5s… rather than 30 ticks at 1s.
    expect(readSshNativeChatTranscript.mock.calls.length).toBeLessThan(12)
    subscription.unsubscribe()
  })

  it('stops polling once unsubscribed', async () => {
    readSshNativeChatTranscript.mockResolvedValue({ unchanged: true, fileSize: 10 })
    const callbacks = harness()

    const subscription = subscribeSshNativeChatTranscript(
      'dev-box',
      { agent: 'claude', sessionId: 'abc', ...callbacks },
      { pollIntervalMs: 5 }
    )
    await vi.advanceTimersByTimeAsync(0)
    subscription.unsubscribe()
    const callsAtUnsubscribe = readSshNativeChatTranscript.mock.calls.length
    await vi.advanceTimersByTimeAsync(50)

    expect(readSshNativeChatTranscript).toHaveBeenCalledTimes(callsAtUnsubscribe)
  })
})
