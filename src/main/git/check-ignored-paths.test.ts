import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkIgnoredPaths } from './check-ignored-paths'
import { gitExecFileAsync } from './runner'
import { GIT_CHECK_IGNORE_TIMEOUT_MS } from '../../shared/git-check-ignore-stdio'

vi.mock('./runner', () => ({
  gitExecFileAsync: vi.fn()
}))

const gitExecFileAsyncMock = vi.mocked(gitExecFileAsync)

describe('checkIgnoredPaths', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('returns ignored paths from git check-ignore output', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'dist/bundle.js\0.env\0', stderr: '' })

    await expect(
      checkIgnoredPaths('/repo', ['dist/bundle.js', 'src/index.ts', '.env'])
    ).resolves.toEqual(['dist/bundle.js', '.env'])

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['-c', 'core.quotePath=false', 'check-ignore', '-z', '--stdin'],
      {
        cwd: '/repo',
        stdin: 'dist/bundle.js\0src/index.ts\0.env\0',
        timeout: GIT_CHECK_IGNORE_TIMEOUT_MS
      }
    )
  })

  it('checks ten thousand paths with one bounded subprocess', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    const paths = Array.from({ length: 10_000 }, (_, index) => `generated/file-${index}.js`)

    await expect(checkIgnoredPaths('/repo', paths)).resolves.toEqual([])

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(gitExecFileAsyncMock.mock.calls[0]?.[1]).toMatchObject({
      timeout: GIT_CHECK_IGNORE_TIMEOUT_MS
    })
    expect(gitExecFileAsyncMock.mock.calls[0]?.[1].stdin?.split('\0')).toHaveLength(10_001)
  })

  it('treats exit code 1 as no ignored paths', async () => {
    gitExecFileAsyncMock.mockRejectedValue(Object.assign(new Error('no matches'), { code: 1 }))

    await expect(checkIgnoredPaths('/repo', ['src/index.ts'])).resolves.toEqual([])
  })

  it('skips the subprocess for an empty path list', async () => {
    await expect(checkIgnoredPaths('/repo', [])).resolves.toEqual([])
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
