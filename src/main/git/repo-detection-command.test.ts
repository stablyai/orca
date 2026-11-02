import { afterEach, describe, expect, it, vi } from 'vitest'
import { gitExecFileAsync, gitExecFileSync } from './runner'
import { gitRepoOutput, runGitRepoCommands, runGitRepoCommandsSync } from './repo-detection-command'

vi.mock('./runner', () => ({ gitExecFileAsync: vi.fn(), gitExecFileSync: vi.fn() }))
afterEach(() => vi.resetAllMocks())

describe('repository command execution', () => {
  it('lets another event-loop turn run while Git is pending, with no synchronous spawn', async () => {
    let finish: (value: { stdout: string; stderr: string }) => void = () => {}
    vi.mocked(gitExecFileAsync).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    let settled = false
    const detection = runGitRepoCommands(
      gitRepoOutput(['rev-parse', '--show-toplevel'], { cwd: '/repo' })
    ).then((result) => {
      settled = true
      return result
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(gitExecFileSync).not.toHaveBeenCalled()
    expect(gitExecFileAsync).toHaveBeenCalledExactlyOnceWith(['rev-parse', '--show-toplevel'], {
      cwd: '/repo',
      timeout: 15_000
    })
    finish({ stdout: '/repo\n', stderr: '' })
    expect(await detection).toBe('/repo\n')
  })

  it('delivers command failures to the shared decision tree in both execution modes', async () => {
    function* withFallback() {
      try {
        return yield* gitRepoOutput(['rev-parse'], { cwd: '/repo' })
      } catch {
        return 'marker fallback'
      }
    }
    vi.mocked(gitExecFileAsync).mockRejectedValue(new Error('Git unavailable'))
    vi.mocked(gitExecFileSync).mockImplementation(() => {
      throw new Error('Git unavailable')
    })
    expect(await runGitRepoCommands(withFallback())).toBe('marker fallback')
    expect(runGitRepoCommandsSync(withFallback())).toBe('marker fallback')
  })

  it('preserves an exception from decision logic after a successful command', async () => {
    const error = new Error('decision failed')
    function* decisionFailure() {
      yield* gitRepoOutput(['first'], { cwd: '/repo' })
      throw error
    }
    vi.mocked(gitExecFileAsync).mockResolvedValue({ stdout: 'result', stderr: '' })
    vi.mocked(gitExecFileSync).mockReturnValue('result')
    await expect(runGitRepoCommands(decisionFailure())).rejects.toBe(error)
    expect(() => runGitRepoCommandsSync(decisionFailure())).toThrow(error)
  })

  it('executes a fallback command yielded while handling a rejected command', async () => {
    function* withFallbackCommand() {
      try {
        return yield* gitRepoOutput(['first'], { cwd: '/repo' })
      } catch {
        return yield* gitRepoOutput(['second'], { cwd: '/repo' })
      }
    }
    vi.mocked(gitExecFileAsync)
      .mockRejectedValueOnce(new Error('first failed'))
      .mockResolvedValueOnce({ stdout: 'fallback', stderr: '' })
    vi.mocked(gitExecFileSync)
      .mockImplementationOnce(() => {
        throw new Error('first failed')
      })
      .mockReturnValueOnce('fallback')
    expect(await runGitRepoCommands(withFallbackCommand())).toBe('fallback')
    expect(runGitRepoCommandsSync(withFallbackCommand())).toBe('fallback')
    expect(vi.mocked(gitExecFileAsync).mock.calls.map(([args]) => args)).toEqual([
      ['first'],
      ['second']
    ])
    expect(vi.mocked(gitExecFileSync).mock.calls.map(([args]) => args)).toEqual([
      ['first'],
      ['second']
    ])
  })
})
