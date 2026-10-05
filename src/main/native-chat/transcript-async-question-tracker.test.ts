import { describe, expect, it, vi } from 'vitest'
import type { NativeChatAsyncQuestionFact } from '../../shared/native-chat-async-questions'
import type { CodexAsyncQuestionScan } from './transcript-async-question-boundary-scan'
import type { TranscriptFileVersion } from './transcript-file-version'
import { createTranscriptAsyncQuestionTracker } from './transcript-async-question-tracker'

const askLine = (callId: string, title: string): string =>
  JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: {
        type: 'AgentMessage',
        id: callId,
        content: [{ type: 'Text', text: title }],
        delivery: 'async',
        questions: [{ title }]
      }
    }
  })
const userLine = JSON.stringify({
  type: 'event_msg',
  payload: { type: 'user_message', message: 'x' }
})
const asked = (itemId: string, title: string): NativeChatAsyncQuestionFact => ({
  kind: 'asked',
  asker: 'root',
  itemId,
  recordId: itemId,
  questions: [{ title }]
})

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (e: Error) => void
} {
  let resolve: (value: T) => void = () => {}
  let reject: (e: Error) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let fileCount = 0
/** A distinct path per test: the fold cache is host-wide. */
const freshFile = (): string => `/rollout-${(fileCount += 1)}.jsonl`
const version = (size: number): TranscriptFileVersion => ({
  identity: '1:2',
  size,
  mtimeMs: size,
  ctimeMs: size
})
const scanned = (facts: NativeChatAsyncQuestionFact[]): CodexAsyncQuestionScan => ({
  facts,
  reachedBoundary: true
})
const drainedTo = (offset: number) => ({ version: version(offset), offset, boundary: `b${offset}` })

const titles = (
  field: ReturnType<ReturnType<typeof createTranscriptAsyncQuestionTracker>['field']>
) => (field.state === 'ready' ? field.questions.map((question) => question.title) : field.state)

describe('createTranscriptAsyncQuestionTracker', () => {
  it('stays pending, buffers appends, then folds them after the reconstruction in order', async () => {
    const scan = deferred<CodexAsyncQuestionScan>()
    const onSettled = vi.fn()
    const tracker = createTranscriptAsyncQuestionTracker({
      filePath: freshFile(),
      onSettled,
      scan: () => scan.promise
    })
    tracker.begin(100, version(100))
    tracker.observeLine(askLine('later', 'Later?'), 'r1')
    expect(tracker.field()).toEqual({ state: 'pending' })
    scan.resolve(scanned([asked('first', 'First?')]))
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))
    expect(titles(tracker.field())).toEqual(['First?', 'Later?'])
  })

  it('applies a user message appended during reconstruction after the reconstructed set', async () => {
    const scan = deferred<CodexAsyncQuestionScan>()
    const tracker = createTranscriptAsyncQuestionTracker({
      filePath: freshFile(),
      onSettled: () => {},
      scan: () => scan.promise
    })
    tracker.begin(100, version(100))
    tracker.observeLine(userLine, 'r1')
    scan.resolve(scanned([asked('first', 'First?')]))
    await vi.waitFor(() => expect(titles(tracker.field())).toEqual([]))
  })

  it('publishes absent after a failed scan, never a partial set, and retries only when a drain asks', async () => {
    vi.useFakeTimers()
    try {
      const filePath = freshFile()
      const second = deferred<CodexAsyncQuestionScan>()
      const scan = vi
        .fn<() => Promise<CodexAsyncQuestionScan>>()
        .mockRejectedValueOnce(new Error('busy'))
        .mockReturnValueOnce(second.promise)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const onSettled = vi.fn()
      const tracker = createTranscriptAsyncQuestionTracker({ filePath, onSettled, scan })
      tracker.begin(42, version(42))
      tracker.observeLine(askLine('later', 'Later?'), 'r1')
      await vi.advanceTimersByTimeAsync(0)
      // Bookkeeping never gates the fallback surface: clients act as with an old host.
      expect(tracker.field()).toEqual({ state: 'absent' })
      expect(onSettled).toHaveBeenCalledOnce()
      // No timer of its own: nothing rescans until the watcher drains.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(scan).toHaveBeenCalledOnce()
      expect(tracker.wantsRetry()).toBe(true)
      tracker.afterDrain(null)
      expect(scan).toHaveBeenLastCalledWith(filePath, 42, expect.anything(), 0)
      // Still absent while the retry runs, so heuristics don't flicker off and on.
      expect(tracker.field()).toEqual({ state: 'absent' })
      expect(tracker.wantsRetry()).toBe(false)
      second.resolve(scanned([asked('first', 'First?')]))
      await vi.advanceTimersByTimeAsync(0)
      expect(titles(tracker.field())).toEqual(['First?', 'Later?'])
      warn.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('backs off between retries and stops wanting one after dispose', async () => {
    vi.useFakeTimers()
    try {
      const scan = vi.fn(async (): Promise<CodexAsyncQuestionScan> => {
        throw new Error('busy')
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const tracker = createTranscriptAsyncQuestionTracker({
        filePath: freshFile(),
        onSettled: () => {},
        scan
      })
      tracker.begin(100, version(100))
      await vi.advanceTimersByTimeAsync(0)
      tracker.afterDrain(null)
      expect(scan).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1_000)
      tracker.afterDrain(null)
      await vi.advanceTimersByTimeAsync(0)
      expect(scan).toHaveBeenCalledTimes(2)
      // Second failure: the next retry waits 2 s, however often the watcher drains.
      tracker.afterDrain(null)
      await vi.advanceTimersByTimeAsync(1_000)
      tracker.afterDrain(null)
      expect(scan).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(tracker.wantsRetry()).toBe(true)
      tracker.dispose()
      expect(tracker.wantsRetry()).toBe(false)
      warn.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a superseded reconstruction after a replace', async () => {
    const stale = deferred<CodexAsyncQuestionScan>()
    const fresh = deferred<CodexAsyncQuestionScan>()
    const scan = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
    const tracker = createTranscriptAsyncQuestionTracker({
      filePath: freshFile(),
      onSettled: () => {},
      scan
    })
    tracker.begin(10, version(10))
    tracker.begin(20, version(20))
    stale.resolve(scanned([asked('old', 'Old?')]))
    fresh.resolve(scanned([asked('new', 'New?')]))
    await vi.waitFor(() => expect(titles(tracker.field())).toEqual(['New?']))
  })

  it('reports a change once', () => {
    const tracker = createTranscriptAsyncQuestionTracker({
      filePath: freshFile(),
      onSettled: () => {}
    })
    tracker.beginFromStart()
    expect(tracker.takeChanged()).toEqual({ state: 'ready', questions: [] })
    expect(tracker.takeChanged()).toBeUndefined()
    tracker.observeLine(askLine('c', 'Now?'), 'r')
    expect(titles(tracker.takeChanged() ?? { state: 'pending' })).toEqual(['Now?'])
    expect(tracker.takeChanged()).toBeUndefined()
  })

  it('treats a record too large to read as a delivered user message when its head says so', () => {
    const tracker = createTranscriptAsyncQuestionTracker({
      filePath: freshFile(),
      onSettled: () => {},
      scan: async () => scanned([])
    })
    tracker.beginFromStart()
    tracker.observeLine(askLine('call-1', 'Color?'), 'r1')
    expect(titles(tracker.field())).toEqual(['Color?'])
    const head = '{"timestamp":"t","type":"event_msg","payload":{"type":"user_message","message":"'
    tracker.observeOversizedRecord(Buffer.from(head), 'r2')
    expect(titles(tracker.field())).toEqual([])
  })
})

describe('the shared per-file fold', () => {
  async function settledTracker(filePath: string, offset: number) {
    const scan = vi.fn(async () => scanned([asked('first', 'First?')]))
    const tracker = createTranscriptAsyncQuestionTracker({ filePath, onSettled: () => {}, scan })
    tracker.begin(offset, version(offset))
    tracker.afterDrain(drainedTo(offset))
    await vi.waitFor(() => expect(tracker.field().state).toBe('ready'))
    return tracker
  }

  it('lets a re-subscribe to an unchanged file publish ready at once, without a scan', async () => {
    const filePath = freshFile()
    await settledTracker(filePath, 500)
    const scan = vi.fn(async () => scanned([]))
    const again = createTranscriptAsyncQuestionTracker({ filePath, onSettled: () => {}, scan })
    again.begin(500, version(500))
    expect(titles(again.field())).toEqual(['First?'])
    expect(scan).not.toHaveBeenCalled()
  })

  it('reads only the bytes written since, after checking the cached boundary', async () => {
    const filePath = freshFile()
    const first = await settledTracker(filePath, 500)
    first.observeLine(askLine('second', 'Second?'), 'r')
    first.afterDrain(drainedTo(700))
    const scan = vi.fn(async () => scanned([asked('third', 'Third?')]))
    scan.mockResolvedValueOnce({ facts: [asked('third', 'Third?')], reachedBoundary: false })
    const fingerprint = vi.fn(async () => 'b700')
    const again = createTranscriptAsyncQuestionTracker({
      filePath,
      onSettled: () => {},
      scan,
      fingerprint
    })
    again.begin(900, version(900))
    await vi.waitFor(() => expect(again.field().state).toBe('ready'))
    expect(fingerprint).toHaveBeenCalledWith(filePath, 700, expect.anything())
    expect(scan).toHaveBeenCalledWith(filePath, 900, expect.anything(), 700)
    expect(titles(again.field())).toEqual(['First?', 'Second?', 'Third?'])
  })

  it('rescans from the start when the cached bytes changed under the same identity', async () => {
    const filePath = freshFile()
    await settledTracker(filePath, 500)
    const scan = vi.fn(async () => scanned([asked('other', 'Other?')]))
    const again = createTranscriptAsyncQuestionTracker({
      filePath,
      onSettled: () => {},
      scan,
      fingerprint: async () => 'rewritten'
    })
    again.begin(900, version(900))
    await vi.waitFor(() => expect(again.field().state).toBe('ready'))
    expect(scan).toHaveBeenCalledWith(filePath, 900, expect.anything(), 0)
    expect(titles(again.field())).toEqual(['Other?'])
  })

  it('drops the cached fold when the new bytes reach a delivered user message', async () => {
    const filePath = freshFile()
    await settledTracker(filePath, 500)
    const scan = vi.fn(async () => scanned([]))
    const again = createTranscriptAsyncQuestionTracker({
      filePath,
      onSettled: () => {},
      scan,
      fingerprint: async () => 'b500'
    })
    again.begin(900, version(900))
    await vi.waitFor(() => expect(again.field().state).toBe('ready'))
    expect(titles(again.field())).toEqual([])
  })

  it('never shares a fold while a line is mid-read', async () => {
    const filePath = freshFile()
    const first = await settledTracker(filePath, 500)
    first.observeLine(askLine('second', 'Second?'), 'r')
    first.afterDrain(null)
    const again = createTranscriptAsyncQuestionTracker({
      filePath,
      onSettled: () => {},
      scan: async () => scanned([])
    })
    again.begin(500, version(500))
    expect(titles(again.field())).toEqual(['First?'])
  })
})
