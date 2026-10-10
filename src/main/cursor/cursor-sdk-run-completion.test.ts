import { describe, expect, it } from 'vitest'
import {
  readCursorSdkRunUntilSettled,
  waitForStoredCursorRun,
  type CursorSdkLiveRun
} from './cursor-sdk-run-completion'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('waitForStoredCursorRun', () => {
  it('ignores an older finished run and returns the one just sent', async () => {
    let calls = 0
    const result = await waitForStoredCursorRun(
      async () => {
        calls += 1
        if (calls === 1) {
          return [{ status: 'finished', result: 'old', startedAt: 1, endedAt: 2 }]
        }
        return [{ status: 'finished', result: 'ok', startedAt: 10_000, endedAt: 10_030 }]
      },
      10_000,
      () => false
    )
    expect(result?.result).toBe('ok')
  })

  it('ignores a run from before the send that started within the clock skew', async () => {
    let calls = 0
    const result = await waitForStoredCursorRun(
      async () => {
        calls += 1
        const previous = { runId: 'run-1', status: 'finished', result: 'old', startedAt: 9_000 }
        return calls === 1
          ? [previous]
          : [previous, { runId: 'run-2', status: 'finished', result: 'ok', startedAt: 10_000 }]
      },
      10_000,
      () => false,
      new Set(['run-1'])
    )
    expect(result?.result).toBe('ok')
  })

  it('stops when the send path takes over', async () => {
    let stop = false
    const pending = waitForStoredCursorRun(
      async () => [{ status: 'running', startedAt: 5_000 }],
      5_000,
      () => stop
    )
    stop = true
    await expect(pending).resolves.toBeNull()
  })
})

describe('readCursorSdkRunUntilSettled', () => {
  it('returns the stored result when the stream stays open after the run finishes', async () => {
    let listener: ((status: string) => void) | undefined
    let returned = false
    let status = 'running'
    const next = deferred<IteratorResult<never>>()
    const run: CursorSdkLiveRun = {
      get status() {
        return status
      },
      result: 'ok',
      stream() {
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => next.promise,
            return: async () => {
              returned = true
              next.resolve({ done: true, value: undefined })
              return { done: true, value: undefined }
            }
          })
        }
      },
      wait: async () => {
        throw new Error('wait should not block on a finished run')
      },
      onDidChangeStatus(nextListener) {
        listener = nextListener
        return () => {}
      }
    }
    const pending = readCursorSdkRunUntilSettled(run, () => {})
    status = 'finished'
    listener?.('finished')
    await expect(pending).resolves.toEqual({ status: 'finished', result: 'ok' })
    expect(returned).toBe(true)
  })

  it('finishes from the agent store while the live run stays running', async () => {
    let waited = false
    const next = deferred<IteratorResult<never>>()
    const run: CursorSdkLiveRun = {
      status: 'running',
      stream() {
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => next.promise,
            return: async () => {
              next.resolve({ done: true, value: undefined })
              return { done: true, value: undefined }
            }
          })
        }
      },
      wait: async () => {
        waited = true
        throw new Error('wait should not block on a stored finish')
      },
      onDidChangeStatus: () => () => {}
    }
    const result = await readCursorSdkRunUntilSettled(
      run,
      () => {},
      async () => ({
        status: 'finished',
        result: 'ok',
        startedAt: 10,
        endedAt: 40
      })
    )
    expect(result).toEqual({ status: 'finished', result: 'ok', durationMs: 30 })
    expect(waited).toBe(false)
  })

  it('forwards stream messages and then waits when the stream ends first', async () => {
    const messages: string[] = []
    const run: CursorSdkLiveRun = {
      status: 'running',
      async *stream() {
        yield { type: 'assistant', text: 'ok' }
      },
      wait: async () => ({ status: 'finished', result: 'ok' }),
      onDidChangeStatus: () => () => {}
    }
    const result = await readCursorSdkRunUntilSettled(run, (message) => {
      if (message.text) {
        messages.push(message.text)
      }
    })
    expect(messages).toEqual(['ok'])
    expect(result.status).toBe('finished')
  })
})
