import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkIgnoredPaths } from './check-ignored-paths'
import { gitExecFileAsync } from './runner'

vi.mock('./runner', () => ({
  gitExecFileAsync: vi.fn()
}))

const gitExecFileAsyncMock = vi.mocked(gitExecFileAsync)

describe('checkIgnoredPaths', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('returns ignored paths from git check-ignore output', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'dist/bundle.js\n.env\n', stderr: '' })

    await expect(
      checkIgnoredPaths('/repo', ['dist/bundle.js', 'src/index.ts', '.env'])
    ).resolves.toEqual(['dist/bundle.js', '.env'])

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        '-c',
        'core.quotePath=false',
        'check-ignore',
        '--',
        'dist/bundle.js',
        'src/index.ts',
        '.env'
      ],
      { cwd: '/repo' }
    )
  })

  it('treats exit code 1 as no ignored paths', async () => {
    gitExecFileAsyncMock.mockRejectedValue(Object.assign(new Error('no matches'), { code: 1 }))

    await expect(checkIgnoredPaths('/repo', ['src/index.ts'])).resolves.toEqual([])
  })
})
