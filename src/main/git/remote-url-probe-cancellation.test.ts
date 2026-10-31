import { expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import { readRemoteUrl } from './remote-url-probe'

it.each([undefined])(
  'forwards caller cancellation to a remote URL read (%s)',
  async (connectionId) => {
    gitExecFileAsyncMock.mockReset()
    let executionSignal: AbortSignal | undefined
    const exec = vi.fn((_args, _cwdOrOptions, options?: { signal?: AbortSignal }) => {
      executionSignal = options?.signal ?? _cwdOrOptions.signal
      const signal = executionSignal
      if (!signal) {
        throw new Error('Missing cancellation')
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    gitExecFileAsyncMock.mockImplementation(exec)
    const controller = new AbortController()
    const read = readRemoteUrl(
      { repoPath: '/repo', connectionId, signal: controller.signal },
      'origin'
    )
    const rejected = expect(read).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(executionSignal?.aborted).toBe(true)
  }
)
