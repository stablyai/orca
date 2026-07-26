import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WslModule from '../wsl'

const { execFileMock, execFileSyncMock, spawnMock, getDefaultWslDistroMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  getDefaultWslDistroMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
  spawn: spawnMock
}))

vi.mock('../wsl', async (importOriginal) => ({
  ...(await importOriginal<typeof WslModule>()),
  getDefaultWslDistro: getDefaultWslDistroMock
}))

import { ghExecFileAsync, glabExecFileAsync } from './runner'
import { _resetGhRateLimitBreaker } from './gh-rate-limit-breaker'

const PRIMARY_RATE_LIMIT_STDERR =
  'gh: API rate limit exceeded for user ID 1775218. Please wait. (HTTP 403)'

type MockChildProcess = EventEmitter & {
  pid: number
  kill: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
}

function createMockChildProcess(pid: number): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess
  child.pid = pid
  child.kill = vi.fn()
  child.unref = vi.fn()
  return child
}

describe('ghExecFileAsync WSL fallback', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    execFileMock.mockReset()
    spawnMock.mockReset()
    getDefaultWslDistroMock.mockReset()
    getDefaultWslDistroMock.mockReturnValue(null)
    _resetGhRateLimitBreaker()
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    _resetGhRateLimitBreaker()
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
  })

  it('falls back to host gh for explicit-repo WSL calls when gh is missing in the distro', async () => {
    execFileMock.mockImplementation((binary, _args, options, callback) => {
      if (typeof options === 'function') {
        callback = options
      }
      if (binary === 'wsl.exe') {
        callback(
          Object.assign(new Error('Command failed: wsl.exe'), {
            stdout: '',
            stderr: 'bash: line 1: gh: command not found\n'
          })
        )
        return
      }
      callback(null, { stdout: '[]', stderr: '' })
    })

    await expect(
      ghExecFileAsync(['issue', 'list', '--repo', 'stablyhq/noqa', '--json', 'number,title'], {
        cwd: String.raw`\\wsl.localhost\Ubuntu\home\jinwoo\stably\noqa`
      })
    ).resolves.toEqual({ stdout: '[]', stderr: '' })

    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      'wsl.exe',
      [
        '-d',
        'Ubuntu',
        '--',
        'bash',
        '-c',
        "cd '/home/jinwoo/stably/noqa' && 'gh' 'issue' 'list' '--repo' 'stablyhq/noqa' '--json' 'number,title'"
      ],
      expect.objectContaining({ cwd: undefined }),
      expect.any(Function)
    )
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      'gh',
      ['issue', 'list', '--repo', 'stablyhq/noqa', '--json', 'number,title'],
      expect.objectContaining({ cwd: undefined }),
      expect.any(Function)
    )
  })

  it('does not fall back for repo-context gh calls without explicit repo context', async () => {
    execFileMock.mockImplementation((_binary, _args, _options, callback) => {
      callback(
        Object.assign(new Error('Command failed: wsl.exe'), {
          stdout: '',
          stderr: 'bash: line 1: gh: command not found\n'
        })
      )
    })

    await expect(
      ghExecFileAsync(['issue', 'list'], {
        cwd: String.raw`\\wsl.localhost\Ubuntu\home\jinwoo\stably\noqa`
      })
    ).rejects.toThrow('Command failed: wsl.exe')

    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('falls back for short-form explicit repo flags used by gh', async () => {
    execFileMock.mockImplementation((binary, _args, options, callback) => {
      if (typeof options === 'function') {
        callback = options
      }
      if (binary === 'wsl.exe') {
        callback(
          Object.assign(new Error('Command failed: wsl.exe'), {
            stdout: '',
            stderr: 'bash: line 1: gh: command not found\n'
          })
        )
        return
      }
      callback(null, { stdout: '[]', stderr: '' })
    })

    await expect(
      ghExecFileAsync(['issue', 'list', '-R', 'stablyhq/noqa'], {
        cwd: String.raw`\\wsl.localhost\Ubuntu\home\jinwoo\stably\noqa`
      })
    ).resolves.toEqual({ stdout: '[]', stderr: '' })

    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      'gh',
      ['issue', 'list', '-R', 'stablyhq/noqa'],
      expect.objectContaining({ cwd: undefined }),
      expect.any(Function)
    )
  })

  it('falls back for compact short-form repo flags used by gh', async () => {
    execFileMock.mockImplementation((binary, _args, options, callback) => {
      if (typeof options === 'function') {
        callback = options
      }
      if (binary === 'wsl.exe') {
        callback(
          Object.assign(new Error('Command failed: wsl.exe'), {
            stdout: '',
            stderr: 'bash: line 1: gh: command not found\n'
          })
        )
        return
      }
      callback(null, { stdout: '[]', stderr: '' })
    })

    await expect(
      ghExecFileAsync(['issue', 'list', '-Rstablyhq/noqa'], {
        cwd: String.raw`\\wsl.localhost\Ubuntu\home\jinwoo\stably\noqa`
      })
    ).resolves.toEqual({ stdout: '[]', stderr: '' })

    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      'gh',
      ['issue', 'list', '-Rstablyhq/noqa'],
      expect.objectContaining({ cwd: undefined }),
      expect.any(Function)
    )
  })

  it('falls back for repo view with an explicit positional repository', async () => {
    execFileMock.mockImplementation((binary, _args, options, callback) => {
      if (typeof options === 'function') {
        callback = options
      }
      if (binary === 'wsl.exe') {
        callback(
          Object.assign(new Error('Command failed: wsl.exe'), {
            stdout: '',
            stderr: 'bash: line 1: gh: command not found\n'
          })
        )
        return
      }
      callback(null, { stdout: '{"isFork":false}', stderr: '' })
    })

    await expect(
      ghExecFileAsync(
        ['repo', 'view', 'github.acme-corp.com/stablyhq/noqa', '--json', 'isFork,parent'],
        {
          cwd: String.raw`\\wsl.localhost\Ubuntu\home\jinwoo\stably\noqa`,
          host: 'github.acme-corp.com'
        }
      )
    ).resolves.toEqual({ stdout: '{"isFork":false}', stderr: '' })

    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      'gh',
      ['repo', 'view', 'github.acme-corp.com/stablyhq/noqa', '--json', 'isFork,parent'],
      expect.objectContaining({ cwd: undefined }),
      expect.any(Function)
    )
  })

  it('does not fall back for gh api calls that depend on repo-context placeholders', async () => {
    execFileMock.mockImplementation((_binary, _args, _options, callback) => {
      callback(
        Object.assign(new Error('Command failed: wsl.exe'), {
          stdout: '',
          stderr: 'bash: line 1: gh: command not found\n'
        })
      )
    })

    await expect(
      ghExecFileAsync(['api', 'repos/stablyhq/noqa/branches/{branch}'], {
        cwd: String.raw`\\wsl.localhost\Ubuntu\home\jinwoo\stably\noqa`
      })
    ).rejects.toThrow('Command failed: wsl.exe')

    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('retries idempotent gh GraphQL query transient failures', async () => {
    execFileMock
      .mockImplementationOnce((_binary, _args, _options, callback) => {
        callback(
          Object.assign(new Error('HTTP 502 Bad Gateway'), {
            stdout: '',
            stderr: 'HTTP 502 Bad Gateway'
          })
        )
      })
      .mockImplementationOnce((_binary, _args, _options, callback) => {
        callback(null, { stdout: '{"data":{}}', stderr: '' })
      })

    await expect(
      ghExecFileAsync(['api', 'graphql', '-f', 'query=query { viewer { login } }'])
    ).resolves.toEqual({ stdout: '{"data":{}}', stderr: '' })

    expect(execFileMock).toHaveBeenCalledTimes(2)
  })

  it('retries a host-pinned idempotent gh GraphQL query after host injection', async () => {
    execFileMock
      .mockImplementationOnce((_binary, _args, _options, callback) => {
        callback(
          Object.assign(new Error('HTTP 502 Bad Gateway'), {
            stdout: '',
            stderr: 'HTTP 502 Bad Gateway'
          })
        )
      })
      .mockImplementationOnce((_binary, _args, _options, callback) => {
        callback(null, { stdout: '{"data":{}}', stderr: '' })
      })

    await expect(
      ghExecFileAsync(['api', 'graphql', '-f', 'query=query { viewer { login } }'], {
        host: 'github.acme-corp.com'
      })
    ).resolves.toEqual({ stdout: '{"data":{}}', stderr: '' })

    expect(execFileMock).toHaveBeenCalledTimes(2)
    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      'gh',
      [
        'api',
        '--hostname',
        'github.acme-corp.com',
        'graphql',
        '-f',
        'query=query { viewer { login } }'
      ],
      expect.any(Object),
      expect.any(Function)
    )
  })

  it('does not retry non-idempotent gh API transient failures', async () => {
    execFileMock.mockImplementation((_binary, _args, _options, callback) => {
      callback(
        Object.assign(new Error('HTTP 502 Bad Gateway'), {
          stdout: '',
          stderr: 'HTTP 502 Bad Gateway'
        })
      )
    })

    await expect(
      ghExecFileAsync(['api', '-X', 'POST', 'repos/stablyai/orca/issues'])
    ).rejects.toThrow('HTTP 502 Bad Gateway')

    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry gh GraphQL mutation transient failures', async () => {
    execFileMock.mockImplementation((_binary, _args, _options, callback) => {
      callback(
        Object.assign(new Error('HTTP 502 Bad Gateway'), {
          stdout: '',
          stderr: 'HTTP 502 Bad Gateway'
        })
      )
    })

    await expect(
      ghExecFileAsync([
        'api',
        'graphql',
        '-f',
        'query=mutation { addStar(input: {}) { starrable { id } } }'
      ])
    ).rejects.toThrow('HTTP 502 Bad Gateway')

    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry high-level gh edit transient failures', async () => {
    execFileMock.mockImplementation((_binary, _args, _options, callback) => {
      callback(
        Object.assign(new Error('HTTP 502 Bad Gateway'), {
          stdout: '',
          stderr: 'HTTP 502 Bad Gateway'
        })
      )
    })

    await expect(
      ghExecFileAsync(['issue', 'edit', '5', '--repo', 'stablyai/orca'])
    ).rejects.toThrow('HTTP 502 Bad Gateway')

    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('retries cwd-less gh calls through the default WSL distro when host gh is missing', async () => {
    getDefaultWslDistroMock.mockReturnValue('Ubuntu')
    execFileMock
      .mockImplementationOnce((_binary, _args, _options, callback) => {
        callback(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }))
      })
      .mockImplementationOnce((_binary, _args, _options, callback) => {
        callback(null, { stdout: '{"resources":{}}', stderr: '' })
      })

    await expect(ghExecFileAsync(['api', 'rate_limit'])).resolves.toEqual({
      stdout: '{"resources":{}}',
      stderr: ''
    })

    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      'wsl.exe',
      ['-d', 'Ubuntu', '--', 'bash', '-c', "'gh' 'api' 'rate_limit'"],
      expect.objectContaining({ cwd: undefined }),
      expect.any(Function)
    )
  })

  it('checks a blocked WSL scope before repeating a native-to-WSL fallback', async () => {
    getDefaultWslDistroMock.mockReturnValue('Ubuntu')
    execFileMock.mockImplementation((binary, _args, _options, callback) => {
      if (binary === 'gh') {
        callback(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT', stderr: '' }))
        return
      }
      callback(
        Object.assign(new Error(PRIMARY_RATE_LIMIT_STDERR), {
          stdout: '',
          stderr: PRIMARY_RATE_LIMIT_STDERR
        })
      )
    })

    await expect(ghExecFileAsync(['api', 'repos/acme/widgets/pulls'])).rejects.toThrow('rate limit')
    await expect(ghExecFileAsync(['api', 'repos/acme/widgets/pulls'])).rejects.toMatchObject({
      ghRateLimitBlocked: true
    })

    expect(execFileMock).toHaveBeenCalledTimes(3)
    expect(execFileMock.mock.calls.map(([binary]) => binary)).toEqual(['gh', 'wsl.exe', 'gh'])
  })

  it('checks a blocked native scope before repeating a WSL-to-native fallback', async () => {
    execFileMock.mockImplementation((binary, _args, _options, callback) => {
      if (binary === 'wsl.exe') {
        callback(
          Object.assign(new Error('Command failed: wsl.exe'), {
            stdout: '',
            stderr: 'bash: line 1: gh: command not found\n'
          })
        )
        return
      }
      callback(
        Object.assign(new Error(PRIMARY_RATE_LIMIT_STDERR), {
          stdout: '',
          stderr: PRIMARY_RATE_LIMIT_STDERR
        })
      )
    })

    const options = {
      cwd: String.raw`\\wsl.localhost\Ubuntu\home\jinwoo\stably\noqa`
    }
    await expect(ghExecFileAsync(['api', 'repos/acme/widgets/pulls'], options)).rejects.toThrow(
      'rate limit'
    )
    await expect(
      ghExecFileAsync(['api', 'repos/acme/widgets/pulls'], options)
    ).rejects.toMatchObject({ ghRateLimitBlocked: true })

    expect(execFileMock).toHaveBeenCalledTimes(3)
    expect(execFileMock.mock.calls.map(([binary]) => binary)).toEqual(['wsl.exe', 'gh', 'wsl.exe'])
  })

  it('does not retry non-idempotent glab transient failures', async () => {
    execFileMock.mockImplementation((_binary, _args, _options, callback) => {
      callback(
        Object.assign(new Error('HTTP 502 Bad Gateway'), {
          stdout: '',
          stderr: 'HTTP 502 Bad Gateway'
        })
      )
    })

    await expect(
      glabExecFileAsync(['api', '-X', 'POST', 'projects/stablyai%2Forca/issues/5/notes'], {
        cwd: String.raw`C:\repo`
      })
    ).rejects.toThrow('HTTP 502 Bad Gateway')

    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry high-level glab update transient failures', async () => {
    execFileMock.mockImplementation((_binary, _args, _options, callback) => {
      callback(
        Object.assign(new Error('HTTP 502 Bad Gateway'), {
          stdout: '',
          stderr: 'HTTP 502 Bad Gateway'
        })
      )
    })

    await expect(
      glabExecFileAsync(['issue', 'update', '5', '-R', 'stablyai/orca'], {
        cwd: String.raw`C:\repo`
      })
    ).rejects.toThrow('HTTP 502 Bad Gateway')

    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('retries cwd-less glab calls through the default WSL distro when host glab is missing', async () => {
    getDefaultWslDistroMock.mockReturnValue('Ubuntu')
    execFileMock
      .mockImplementationOnce((_binary, _args, _options, callback) => {
        callback(Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' }))
      })
      .mockImplementationOnce((_binary, _args, _options, callback) => {
        callback(null, { stdout: '[]', stderr: '' })
      })

    await expect(glabExecFileAsync(['api', 'projects'])).resolves.toEqual({
      stdout: '[]',
      stderr: ''
    })

    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      'wsl.exe',
      ['-d', 'Ubuntu', '--', 'bash', '-c', "'glab' 'api' 'projects'"],
      expect.objectContaining({ cwd: undefined }),
      expect.any(Function)
    )
  })

  it('times out the default-WSL glab fallback and waits for full tree cleanup', async () => {
    vi.useFakeTimers()
    getDefaultWslDistroMock.mockReturnValue('Ubuntu')
    const nativeChild = createMockChildProcess(1200)
    const wslChild = createMockChildProcess(2400)
    const taskkill = createMockChildProcess(3600)
    execFileMock
      .mockImplementationOnce((_binary, _args, _options, callback) => {
        callback(Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' }))
        return nativeChild
      })
      .mockReturnValueOnce(wslChild)
    spawnMock.mockReturnValue(taskkill)

    const promise = glabExecFileAsync(['auth', 'status'], { timeout: 1000 })
    const rejection = expect(promise).rejects.toThrow('wsl.exe timed out.')
    let rejected = false
    void promise.catch(() => {
      rejected = true
    })

    await vi.advanceTimersByTimeAsync(999)
    expect(spawnMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '2400', '/t', '/f'],
      expect.objectContaining({ stdio: 'ignore', windowsHide: true })
    )
    await Promise.resolve()
    expect(rejected).toBe(false)

    taskkill.emit('close', 0)
    await rejection
    expect(wslChild.kill).not.toHaveBeenCalled()
  })

  it('aborts the default-WSL glab fallback with full process-tree cleanup', async () => {
    getDefaultWslDistroMock.mockReturnValue('Ubuntu')
    const nativeChild = createMockChildProcess(1200)
    const wslChild = createMockChildProcess(2400)
    const taskkill = createMockChildProcess(3600)
    execFileMock
      .mockImplementationOnce((_binary, _args, _options, callback) => {
        callback(Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' }))
        return nativeChild
      })
      .mockReturnValueOnce(wslChild)
    spawnMock.mockReturnValue(taskkill)
    const controller = new AbortController()

    const promise = glabExecFileAsync(['auth', 'status'], { signal: controller.signal })
    const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(2))
    controller.abort()

    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      'wsl.exe',
      ['-d', 'Ubuntu', '--', 'bash', '-c', "'glab' 'auth' 'status'"],
      expect.not.objectContaining({ signal: controller.signal }),
      expect.any(Function)
    )
    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '2400', '/t', '/f'],
      expect.objectContaining({ stdio: 'ignore', windowsHide: true })
    )
    taskkill.emit('close', 0)

    await rejection
    expect(wslChild.kill).not.toHaveBeenCalled()
  })

  it('does not wake the default WSL distro for host-only GitLab diagnostics', async () => {
    getDefaultWslDistroMock.mockReturnValue('Ubuntu')
    execFileMock
      .mockImplementationOnce((_binary, _args, _options, callback) => {
        callback(Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' }))
      })
      .mockImplementationOnce((_binary, _args, _options, callback) => {
        callback(null, { stdout: 'Logged in to gitlab.com', stderr: '' })
      })

    await expect(
      glabExecFileAsync(['auth', 'status'], { allowDefaultWslFallback: false })
    ).rejects.toThrow('spawn glab ENOENT')

    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(execFileMock).toHaveBeenCalledWith(
      'glab',
      ['auth', 'status'],
      expect.objectContaining({ cwd: undefined }),
      expect.any(Function)
    )
  })

  it('still retries idempotent glab transient failures', async () => {
    execFileMock
      .mockImplementationOnce((_binary, _args, _options, callback) => {
        callback(
          Object.assign(new Error('HTTP 502 Bad Gateway'), {
            stdout: '',
            stderr: 'HTTP 502 Bad Gateway'
          })
        )
      })
      .mockImplementationOnce((_binary, _args, _options, callback) => {
        callback(null, { stdout: '[]', stderr: '' })
      })

    await expect(
      glabExecFileAsync(['api', 'projects/stablyai%2Forca/issues'], {
        cwd: String.raw`C:\repo`
      })
    ).resolves.toEqual({ stdout: '[]', stderr: '' })

    expect(execFileMock).toHaveBeenCalledTimes(2)
  })
})
