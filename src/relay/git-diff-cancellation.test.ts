import { describe, expect, it, vi } from 'vitest'
import { createGitHandlerRelay } from './git-handler-test-harness'
import type { GitHandlerOperationHost } from './git-handler-operation-context'

describe('relay diff request cancellation', () => {
  it('lets one client cancel without stopping another client sharing the same read', async () => {
    const { handler, dispatcher } = createGitHandlerRelay()
    let finish!: () => void
    const ready = new Promise<Buffer>((resolve) => {
      finish = () => resolve(Buffer.from('content\n'))
    })
    const signals: AbortSignal[] = []
    const gitBuffer = vi.fn<GitHandlerOperationHost['gitBuffer']>(async (_args, _cwd, options) => {
      if (options?.signal) {
        signals.push(options.signal)
      }
      return ready
    })
    Object.assign(handler, { gitBuffer, git: async () => ({ stdout: '', stderr: '' }) })
    const params = { worktreePath: '/repo', filePath: 'file.txt', staged: true }
    const first = new AbortController()
    const second = new AbortController()
    const canceled = dispatcher.callRequest('git.diff', params, {
      isStale: () => false,
      signal: first.signal
    })
    const remaining = dispatcher.callRequest('git.diff', params, {
      isStale: () => false,
      signal: second.signal
    })
    await vi.waitFor(() => expect(gitBuffer).toHaveBeenCalledTimes(2))
    const rejected = expect(canceled).rejects.toMatchObject({ name: 'AbortError' })
    first.abort()
    await rejected
    expect(signals.every((signal) => !signal.aborted)).toBe(true)
    finish()
    await expect(remaining).resolves.toMatchObject({
      originalContent: 'content\n',
      modifiedContent: 'content\n'
    })
    handler.dispose()
  })

  it('stops the shared subprocess reads when their last client cancels', async () => {
    const { handler, dispatcher } = createGitHandlerRelay()
    const signals: AbortSignal[] = []
    const gitBuffer = vi.fn<GitHandlerOperationHost['gitBuffer']>(async (_args, _cwd, options) => {
      const signal = options?.signal
      if (!signal) {
        throw new Error('Request cancellation was not passed to the blob read.')
      }
      signals.push(signal)
      return new Promise<Buffer>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    Object.assign(handler, { gitBuffer, git: async () => ({ stdout: '', stderr: '' }) })
    const controller = new AbortController()
    const pending = dispatcher.callRequest(
      'git.diff',
      { worktreePath: '/repo', filePath: 'file.txt', staged: true },
      {
        isStale: () => false,
        signal: controller.signal
      }
    )
    await vi.waitFor(() => expect(gitBuffer).toHaveBeenCalledTimes(2))
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    handler.dispose()
  })
})
