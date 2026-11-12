import type * as GitExecFileModule from './command-runner/git-exec-file'
import type * as GhExecFileModule from './command-runner/hosted-cli/gh-exec-file'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())
const ghExecFileAsyncMock = vi.hoisted(() => vi.fn())

vi.mock('./command-runner/git-exec-file', async () => {
  const actual = await vi.importActual<typeof GitExecFileModule>('./command-runner/git-exec-file')
  return {
    ...actual,
    gitExecFileAsync: gitExecFileAsyncMock
  }
})

vi.mock('./command-runner/hosted-cli/gh-exec-file', async () => {
  const actual = await vi.importActual<typeof GhExecFileModule>(
    './command-runner/hosted-cli/gh-exec-file'
  )
  return {
    ...actual,
    ghExecFileAsync: ghExecFileAsyncMock
  }
})
import { resolveLocalGitUsernameDetailed, resetGhLoginCacheForTests } from './git-username'

function makeExecError(
  message: string,
  extra: {
    code?: string
    killed?: boolean
    signal?: string
    stdout?: string
    stderr?: string
  } = {}
): Error {
  return Object.assign(new Error(message), { stdout: '', stderr: '', ...extra })
}

describe('resolveLocalGitUsername', () => {
  let gitConfig: Record<string, string>
  let originRemoteUrl: string | undefined
  let remoteUrls: Record<string, string>
  let currentBranch: string

  beforeEach(() => {
    vi.resetAllMocks()
    resetGhLoginCacheForTests()
    gitConfig = {}
    originRemoteUrl = undefined
    remoteUrls = {}
    currentBranch = ''

    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'config' && args[1] === '--list') {
        return {
          stdout: Object.entries(gitConfig)
            .map(([key, value]) => `${key}\n${value}\0`)
            .join(''),
          stderr: ''
        }
      }
      if (args[0] === 'config' && args[1] === '--get') {
        const value = gitConfig[args[2]]
        if (value !== undefined) {
          return { stdout: `${value}\n`, stderr: '' }
        }
        throw makeExecError(`missing config ${args[2]}`)
      }
      if (args[0] === 'remote' && args.length === 1) {
        const remotes = new Set(Object.keys(remoteUrls))
        if (originRemoteUrl) {
          remotes.add('origin')
        }
        return { stdout: `${[...remotes].join('\n')}\n`, stderr: '' }
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        const remoteUrl = args[2] === 'origin' ? originRemoteUrl : remoteUrls[args[2]]
        if (remoteUrl) {
          return { stdout: `${remoteUrl}\n`, stderr: '' }
        }
        throw makeExecError(`missing ${args[2]} remote`)
      }
      if (args[0] === 'branch' && args[1] === '--show-current') {
        return { stdout: `${currentBranch}\n`, stderr: '' }
      }
      if (args[0] === 'symbolic-ref') {
        throw makeExecError('no origin/HEAD')
      }
      if (args[0] === 'rev-parse') {
        throw makeExecError(`missing ref ${args.at(-1)}`)
      }
      throw makeExecError(`unexpected git args: ${args.join(' ')}`)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('settles within the wall even when the gh child never exits', async () => {
    vi.useFakeTimers()
    originRemoteUrl = 'https://github.com/stablyai/orca.git'
    // Simulate a killed gh whose descendants keep its stdio pipes open.
    ghExecFileAsyncMock.mockImplementation(() => new Promise(() => {}))

    const resolution = resolveLocalGitUsernameDetailed('/repo')
    await vi.advanceTimersByTimeAsync(10_100)
    await expect(resolution).resolves.toEqual({ username: '', authoritative: false })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })
})
