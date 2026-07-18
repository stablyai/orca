import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  commandExecFileAsyncMock,
  gitExecFileAsyncMock,
  invalidateEnvironmentMock,
  isCachedGitUnavailableMock,
  readEnvironmentMock,
  resolveTargetMock,
  runLoginShellMock
} = vi.hoisted(() => ({
  commandExecFileAsyncMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  invalidateEnvironmentMock: vi.fn(),
  isCachedGitUnavailableMock: vi.fn(),
  readEnvironmentMock: vi.fn(),
  resolveTargetMock: vi.fn(),
  runLoginShellMock: vi.fn()
}))

vi.mock('./runner', () => ({
  DEFAULT_GIT_MAX_BUFFER: 10 * 1024 * 1024,
  commandExecFileAsync: commandExecFileAsyncMock,
  gitExecFileAsync: gitExecFileAsyncMock,
  nonInteractiveGitEnv: (env: NodeJS.ProcessEnv = {}) => ({ ...env, GIT_TERMINAL_PROMPT: '0' })
}))

vi.mock('./wsl-status-environment', () => ({
  invalidateWslStatusEnvironment: invalidateEnvironmentMock
}))

vi.mock('./wsl-status-runner', () => ({
  cachedGitVerificationCommand: (gitPath: string) => `[ -x '${gitPath}' ] || exit 127`,
  gitStatusExecFileAsync: gitExecFileAsyncMock,
  isCachedGitUnavailable: isCachedGitUnavailableMock,
  readWslStatusEnvironment: readEnvironmentMock,
  resolveWslStatusTarget: resolveTargetMock,
  runWslStatusLoginShellGit: runLoginShellMock,
  translateWslStatusArg: (arg: string) => arg,
  wslStatusEnvironmentAssignments: () => [
    'PATH=/usr/bin',
    'GIT_OPTIONAL_LOCKS=0',
    'GIT_TERMINAL_PROMPT=0'
  ]
}))

vi.mock('../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: () => unknown) => run()
}))

import {
  clearWslStatusBatchUnsafeCacheForTests,
  gitStatusExecBatchAsync,
  parseWslStatusBatchOutput
} from './wsl-status-batch'

const target = { distro: 'Ubuntu', linuxCwd: '/repo' }
const environment = { gitPath: '/usr/bin/git', path: '/usr/bin' }
const commands = [
  ['diff', '--cached', '--numstat', '-z'],
  ['diff', '--numstat', '-z']
]
const options = {
  cwd: 'C:\\repo',
  env: { GIT_OPTIONAL_LOCKS: '0' },
  wslDistro: 'Ubuntu'
}

function framedOutput(script: string, outputs: string[], exitCodes = [0, 0]): string {
  const token = script.match(/orca-status-batch-[a-f0-9]+/)?.[0]
  if (!token) {
    throw new Error('batch token missing from shell command')
  }
  return outputs
    .map(
      (output, index) =>
        `${Buffer.from(output, 'utf8').toString('latin1')}\0\0${token}:${index}:rc=${exitCodes[index]}\0`
    )
    .join('')
}

beforeEach(() => {
  clearWslStatusBatchUnsafeCacheForTests()
  commandExecFileAsyncMock.mockReset()
  gitExecFileAsyncMock.mockReset()
  invalidateEnvironmentMock.mockReset()
  isCachedGitUnavailableMock.mockReset()
  readEnvironmentMock.mockReset().mockResolvedValue(environment)
  resolveTargetMock.mockReset().mockReturnValue(target)
  runLoginShellMock.mockReset()
})

describe('parseWslStatusBatchOutput', () => {
  it('preserves NUL-delimited rename payloads behind collision-proof frames', () => {
    const first = '1\t0\t\0old-name\0new-name\0'
    const second = '3\t4\tsrc/file.ts\0'
    const stdout = `${first}\0\0token:0:rc=0\0${second}\0\0token:1:rc=1\0`

    expect(parseWslStatusBatchOutput(stdout, 'token', 2)).toEqual([
      { output: first, exitCode: 0 },
      { output: second, exitCode: 1 }
    ])
  })

  it('rejects missing, reordered, or trailing frames', () => {
    expect(parseWslStatusBatchOutput('\0\0token:1:rc=0\0', 'token', 2)).toBeNull()
    expect(parseWslStatusBatchOutput('\0\0token:0:rc=0\0trailing', 'token', 1)).toBeNull()
  })
})

describe('gitStatusExecBatchAsync', () => {
  it('runs both numstats in one guarded WSL crossing and preserves an independent failure', async () => {
    commandExecFileAsyncMock.mockImplementation(async (_binary: string, args: string[]) => ({
      stdout: framedOutput(args[5], ['1\t0\ta.ts\0', ''], [0, 1]),
      stderr: framedOutput(args[5], ['', ''], [0, 1])
    }))

    await expect(gitStatusExecBatchAsync(commands, options)).resolves.toEqual([
      { stdout: '1\t0\ta.ts\0', stderr: '' },
      null
    ])
    expect(commandExecFileAsyncMock).toHaveBeenCalledOnce()
    const args = commandExecFileAsyncMock.mock.calls[0][1] as string[]
    expect(args.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--', '/bin/sh', '-c'])
    expect(args[5]).toContain("cd '/repo'")
    expect(args[5]).toContain("'GIT_OPTIONAL_LOCKS=0'")
    expect(args[5]).toContain("'GIT_TERMINAL_PROMPT=0'")
    expect(args[5]).toContain("'--cached'")
    expect(args[5]).toContain("'--numstat'")
    expect(args[5]).not.toContain('&&')
  })

  it('caches a direct fallback when framing is structurally invalid', async () => {
    commandExecFileAsyncMock.mockResolvedValue({ stdout: 'not framed', stderr: '' })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => ({
      stdout: args.includes('--cached') ? 'staged' : 'unstaged',
      stderr: ''
    }))

    const expected = [
      { stdout: 'staged', stderr: '' },
      { stdout: 'unstaged', stderr: '' }
    ]
    await expect(gitStatusExecBatchAsync(commands, options)).resolves.toEqual(expected)
    await expect(gitStatusExecBatchAsync(commands, options)).resolves.toEqual(expected)
    expect(commandExecFileAsyncMock).toHaveBeenCalledOnce()
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(4)
  })

  it('enforces each command byte cap while preserving the other framed result', async () => {
    commandExecFileAsyncMock.mockImplementation(async (_binary: string, args: string[]) => ({
      stdout: framedOutput(args[5], ['é'.repeat(6), 'small']),
      stderr: framedOutput(args[5], ['', ''])
    }))

    await expect(gitStatusExecBatchAsync(commands, { ...options, maxBuffer: 10 })).resolves.toEqual(
      [null, { stdout: 'small', stderr: '' }]
    )
    const execOptions = commandExecFileAsyncMock.mock.calls[0][2] as { maxBuffer: number }
    expect(execOptions.maxBuffer).toBeGreaterThan(20)
  })

  it('adds frame headroom when both command payloads reach their byte cap', async () => {
    commandExecFileAsyncMock.mockImplementation(async (_binary: string, args: string[]) => ({
      stdout: framedOutput(args[5], ['a'.repeat(10), 'b'.repeat(10)]),
      stderr: framedOutput(args[5], ['', ''])
    }))

    await expect(gitStatusExecBatchAsync(commands, { ...options, maxBuffer: 10 })).resolves.toEqual(
      [
        { stdout: 'a'.repeat(10), stderr: '' },
        { stdout: 'b'.repeat(10), stderr: '' }
      ]
    )
  })

  it('reruns separately when aggregate stdout overflow prevents a later command', async () => {
    commandExecFileAsyncMock.mockImplementation(
      async (_binary: string, args: string[], execOptions: { maxBuffer: number }) => {
        const stdout = framedOutput(args[5], ['a'.repeat(21), 'small'])
        expect(Buffer.byteLength(stdout)).toBeGreaterThan(execOptions.maxBuffer)
        throw new Error('stdout exceeded maxBuffer')
      }
    )
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('--cached')) {
        throw new Error('stdout exceeded maxBuffer')
      }
      return { stdout: 'small', stderr: '' }
    })

    const overflowOptions = { ...options, maxBuffer: 10 }
    await expect(gitStatusExecBatchAsync(commands, overflowOptions)).resolves.toEqual([
      null,
      { stdout: 'small', stderr: '' }
    ])
    await expect(gitStatusExecBatchAsync(commands, overflowOptions)).resolves.toEqual([
      null,
      { stdout: 'small', stderr: '' }
    ])
    expect(commandExecFileAsyncMock).toHaveBeenCalledOnce()
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(4)
  })

  it('preserves stderr attribution and independent caps without rerunning warnings', async () => {
    commandExecFileAsyncMock.mockImplementation(async (_binary: string, args: string[]) => ({
      stdout: framedOutput(args[5], ['batched staged', 'batched unstaged']),
      stderr: framedOutput(args[5], ['warning from one command', ''])
    }))

    await expect(gitStatusExecBatchAsync(commands, options)).resolves.toEqual([
      { stdout: 'batched staged', stderr: 'warning from one command' },
      { stdout: 'batched unstaged', stderr: '' }
    ])
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('rejects only the command whose framed stderr exceeds its byte cap', async () => {
    commandExecFileAsyncMock.mockImplementation(async (_binary: string, args: string[]) => ({
      stdout: framedOutput(args[5], ['staged', 'unstaged']),
      stderr: framedOutput(args[5], ['warning too large', ''])
    }))

    await expect(gitStatusExecBatchAsync(commands, { ...options, maxBuffer: 10 })).resolves.toEqual(
      [null, { stdout: 'unstaged', stderr: '' }]
    )
  })

  it('preserves a literal replacement character without an ambiguous rerun', async () => {
    commandExecFileAsyncMock.mockImplementation(async (_binary: string, args: string[]) => ({
      stdout: framedOutput(args[5], ['bad\uFFFDname', 'batched']),
      stderr: framedOutput(args[5], ['', ''])
    }))

    await expect(gitStatusExecBatchAsync(commands, options)).resolves.toEqual([
      { stdout: 'bad\uFFFDname', stderr: '' },
      { stdout: 'batched', stderr: '' }
    ])
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('invalidates and uses guarded fallbacks when the cached executable cannot launch', async () => {
    const unavailable = Object.assign(new Error('missing cached git'), { code: 127 })
    commandExecFileAsyncMock.mockRejectedValue(unavailable)
    isCachedGitUnavailableMock.mockReturnValue(true)
    runLoginShellMock.mockResolvedValue({ stdout: 'fallback', stderr: '' })

    await expect(gitStatusExecBatchAsync(commands, options)).resolves.toEqual([
      { stdout: 'fallback', stderr: '' },
      { stdout: 'fallback', stderr: '' }
    ])
    expect(invalidateEnvironmentMock).toHaveBeenCalledWith('Ubuntu', environment)
    expect(runLoginShellMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry a genuine Git or batch-process failure', async () => {
    commandExecFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('git failed'), { code: 128 })
    )
    isCachedGitUnavailableMock.mockReturnValue(false)

    await expect(gitStatusExecBatchAsync(commands, options)).resolves.toEqual([null, null])
    expect(runLoginShellMock).not.toHaveBeenCalled()
    expect(invalidateEnvironmentMock).not.toHaveBeenCalled()
  })

  it('delegates native and SSH-provider-style execution without WSL batching', async () => {
    resolveTargetMock.mockReturnValue(null)
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'native', stderr: '' })

    await expect(gitStatusExecBatchAsync(commands, { cwd: '/repo' })).resolves.toEqual([
      { stdout: 'native', stderr: '' },
      { stdout: 'native', stderr: '' }
    ])
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(commandExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('propagates cancellation without starting fallbacks', async () => {
    const controller = new AbortController()
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' })
    commandExecFileAsyncMock.mockImplementation(async () => {
      controller.abort()
      throw aborted
    })

    await expect(
      gitStatusExecBatchAsync(commands, { ...options, signal: controller.signal })
    ).rejects.toBe(aborted)
    expect(runLoginShellMock).not.toHaveBeenCalled()
  })
})
