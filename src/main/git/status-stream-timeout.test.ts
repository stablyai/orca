import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, gitStreamStdoutMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitStreamStdoutMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileAsyncBuffer: vi.fn(),
  gitOptionalLocksDisabledEnv: (env: NodeJS.ProcessEnv = process.env) => ({
    ...env,
    GIT_OPTIONAL_LOCKS: '0'
  }),
  gitStreamStdout: gitStreamStdoutMock
}))

import { getStatus } from './status'

describe('getStatus streamed git timeout', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitStreamStdoutMock.mockReset()
    gitStreamStdoutMock.mockImplementation(
      async (_args: string[], options: { onStdout: (chunk: string) => boolean | void }) => {
        options.onStdout('')
        return { stoppedEarly: false }
      }
    )
  })

  it('bounds streamed git status reads with a timeout while preserving abort signals', async () => {
    const controller = new AbortController()

    await getStatus('C:\\repo', { signal: controller.signal })

    expect(gitStreamStdoutMock).toHaveBeenCalledWith(
      [
        '-c',
        'core.quotePath=false',
        'status',
        '--porcelain=v2',
        '--branch',
        '--untracked-files=all'
      ],
      expect.objectContaining({
        cwd: 'C:\\repo',
        signal: controller.signal,
        timeout: 60_000
      })
    )
  })
})
