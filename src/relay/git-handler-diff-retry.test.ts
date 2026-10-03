import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitHandlerRelay } from './git-handler-test-harness'
import type { GitHandlerOperationHost } from './git-handler-operation-context'

function deferredBlob() {
  let resolve: (value: Buffer) => void = () => {
    throw new Error('Deferred promise is not initialized')
  }
  const promise = new Promise<Buffer>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

const comparisons = [
  { method: 'git.diff', params: { staged: true } },
  {
    method: 'git.branchDiff',
    params: { baseRef: 'a'.repeat(40), headOid: 'b'.repeat(40), includePatch: true }
  },
  {
    method: 'git.commitDiff',
    params: { parentOid: 'a'.repeat(40), commitOid: 'b'.repeat(40) }
  }
]

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('relay diff retries after a hung read', () => {
  it.each(comparisons)(
    '$method starts a fresh read after 30 seconds',
    async ({ method, params }) => {
      const { handler, dispatcher } = createGitHandlerRelay()
      const oldBlob = deferredBlob()
      const freshBlob = deferredBlob()
      const signals: AbortSignal[] = []
      const gitBuffer = vi.fn<GitHandlerOperationHost['gitBuffer']>(
        async (_args, _cwd, options) => {
          if (!options?.signal) {
            throw new Error('The diff read did not receive its shared cancellation signal')
          }
          signals.push(options.signal)
          return signals.length <= 2 ? oldBlob.promise : freshBlob.promise
        }
      )
      Object.assign(handler, { gitBuffer, git: async () => ({ stdout: '', stderr: '' }) })
      const request = { worktreePath: '/repo', filePath: 'file.txt', ...params }
      const resultFor = (content: string) => {
        const diff = { originalContent: content, modifiedContent: content }
        return method === 'git.branchDiff' ? [diff] : diff
      }
      try {
        const first = dispatcher.callRequest(method, request)
        await vi.advanceTimersByTimeAsync(29_999)
        const joined = dispatcher.callRequest(method, request)
        await vi.advanceTimersByTimeAsync(0)
        expect(gitBuffer).toHaveBeenCalledTimes(2)

        await vi.advanceTimersByTimeAsync(1)
        const retry = dispatcher.callRequest(method, request)
        await vi.advanceTimersByTimeAsync(0)
        expect(gitBuffer).toHaveBeenCalledTimes(4)
        expect(signals.every((signal) => !signal.aborted)).toBe(true)

        oldBlob.resolve(Buffer.from('old content\n'))
        await expect(first).resolves.toMatchObject(resultFor('old content\n'))
        await expect(joined).resolves.toMatchObject(resultFor('old content\n'))
        const retryJoin = dispatcher.callRequest(method, request)
        await vi.advanceTimersByTimeAsync(0)
        expect(gitBuffer).toHaveBeenCalledTimes(4)
        freshBlob.resolve(Buffer.from('fresh content\n'))
        await expect(retry).resolves.toMatchObject(resultFor('fresh content\n'))
        await expect(retryJoin).resolves.toMatchObject(resultFor('fresh content\n'))
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        handler.dispose()
      }
    }
  )
})
