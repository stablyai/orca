import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { commandExecFileAsyncMock, gitExecFileAsyncMock, nonInteractiveGitEnvMock } = vi.hoisted(
  () => ({
    commandExecFileAsyncMock: vi.fn(),
    gitExecFileAsyncMock: vi.fn(),
    nonInteractiveGitEnvMock: vi.fn((env: NodeJS.ProcessEnv = {}) => ({
      ...env,
      LANGUAGE: 'en',
      LC_ALL: 'en_US.UTF-8',
      LANG: 'en_US.UTF-8',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GCM_INTERACTIVE: 'never',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.interactive',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'credential.guiPrompt',
      GIT_CONFIG_VALUE_1: 'false'
    }))
  })
)

vi.mock('./runner', () => ({
  commandExecFileAsync: commandExecFileAsyncMock,
  extractExecError: (error: unknown) => {
    const detail = error as { stderr?: unknown; stdout?: unknown; message?: unknown }
    return {
      stderr: typeof detail?.stderr === 'string' ? detail.stderr : String(detail?.message ?? ''),
      stdout: typeof detail?.stdout === 'string' ? detail.stdout : ''
    }
  },
  gitExecFileAsync: gitExecFileAsyncMock,
  nonInteractiveGitEnv: nonInteractiveGitEnvMock
}))

vi.mock('../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: () => unknown) => run()
}))

import { clearWslStatusEnvironmentCacheForTests } from './wsl-status-environment'
import {
  directWslGitArgs,
  gitStatusExecFileAsync,
  loginShellWslGitArgs,
  resolveWslStatusTarget
} from './wsl-status-runner'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const probeOutput = '\0orca-wsl-status-environment-v1\0/usr/bin/git\0/home/me/.local/bin:/usr/bin\0'

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function wslOptions(distro = 'Ubuntu'): {
  cwd: string
  env: NodeJS.ProcessEnv
  wslDistro: string
} {
  return { cwd: 'C:\\repo', env: { GIT_OPTIONAL_LOCKS: '0' }, wslDistro: distro }
}

beforeEach(() => {
  stubPlatform('win32')
  clearWslStatusEnvironmentCacheForTests()
  commandExecFileAsyncMock.mockReset()
  gitExecFileAsyncMock.mockReset()
  nonInteractiveGitEnvMock.mockClear()
})

afterAll(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
})

describe('resolveWslStatusTarget', () => {
  it('supports both UNC forms and an explicit distro for drive paths', () => {
    expect(resolveWslStatusTarget({ cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo' })).toEqual({
      distro: 'Ubuntu',
      linuxCwd: '/home/me/repo'
    })
    expect(resolveWslStatusTarget({ cwd: '\\\\wsl$\\Debian\\srv\\repo' })).toEqual({
      distro: 'Debian',
      linuxCwd: '/srv/repo'
    })
    expect(resolveWslStatusTarget({ cwd: 'D:\\src\\repo', wslDistro: 'Ubuntu' })).toEqual({
      distro: 'Ubuntu',
      linuxCwd: '/mnt/d/src/repo'
    })
  })

  it('leaves native and SSH-style local execution unchanged', () => {
    stubPlatform('linux')
    expect(resolveWslStatusTarget({ cwd: '/repo', wslDistro: 'Ubuntu' })).toBeNull()
  })
})

describe('directWslGitArgs', () => {
  it('runs from the repository cwd with cached PATH and all guards inside WSL', () => {
    const args = directWslGitArgs(
      { distro: 'Ubuntu', linuxCwd: '/home/me/repo' },
      { gitPath: '/home/me/.local/share/mise/shims/git', path: '/home/me/.local/bin:/usr/bin' },
      ['status', '--porcelain=v2'],
      nonInteractiveGitEnvMock({ GIT_OPTIONAL_LOCKS: '1' })
    )
    const command = args[5]

    expect(args.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--', '/bin/sh', '-c'])
    expect(args[6]).toBe('orca:git status')
    expect(command).toContain("cd '/home/me/repo'")
    expect(command).toContain("'PATH=/home/me/.local/bin:/usr/bin'")
    expect(command).toContain("'/home/me/.local/share/mise/shims/git' 'status'")
    expect(command).toContain("'GIT_OPTIONAL_LOCKS=0'")
    expect(command).toContain("'GIT_TERMINAL_PROMPT=0'")
    expect(command).toContain("'GIT_SSH_COMMAND=ssh -o BatchMode=yes'")
    expect(command).toContain("'GIT_CONFIG_KEY_0=credential.interactive'")
    expect(command).not.toContain("'-C'")
  })

  it('keeps login-shell git functions available in the guarded fallback', () => {
    const args = loginShellWslGitArgs(
      { distro: 'Ubuntu', linuxCwd: '/repo' },
      ['status'],
      nonInteractiveGitEnvMock({ GIT_OPTIONAL_LOCKS: '1' })
    )
    const command = args[5]

    expect(command).toContain(String.raw`GIT_OPTIONAL_LOCKS='\''0'\''`)
    expect(command).toContain(String.raw`GIT_TERMINAL_PROMPT='\''0'\''`)
    expect(command).toContain(String.raw`'\''git'\'' '\''status'\''`)
    expect(command).not.toContain("'/usr/bin/env'")
  })
})

describe('gitStatusExecFileAsync', () => {
  it('resolves once and reuses the cached environment for later calls', async () => {
    commandExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: probeOutput, stderr: '' })
      .mockResolvedValue({ stdout: 'ok', stderr: '' })

    await gitStatusExecFileAsync(['status'], wslOptions())
    await gitStatusExecFileAsync(['rev-list', '--count', 'HEAD'], wslOptions())

    expect(commandExecFileAsyncMock).toHaveBeenCalledTimes(3)
    const scripts = commandExecFileAsyncMock.mock.calls.map(([, args]) => args as string[])
    const probes = scripts.filter((args) => args[5]?.includes('orca-wsl-status-environment-v1'))
    expect(probes).toHaveLength(1)
    expect(scripts.filter((args) => args[4] === '-c')).toHaveLength(2)
  })

  it('keeps environment probes isolated per distro', async () => {
    commandExecFileAsyncMock.mockImplementation(async (_command: string, args: string[]) =>
      args[5]?.includes('orca-wsl-status-environment-v1')
        ? { stdout: probeOutput, stderr: '' }
        : { stdout: 'ok', stderr: '' }
    )

    await gitStatusExecFileAsync(['status'], wslOptions('Ubuntu'))
    await gitStatusExecFileAsync(['status'], wslOptions('Debian'))

    const probes = commandExecFileAsyncMock.mock.calls.filter(([, args]) =>
      (args as string[])[5]?.includes('orca-wsl-status-environment-v1')
    )
    expect(probes.map(([, args]) => (args as string[])[1])).toEqual(['Ubuntu', 'Debian'])
  })

  it('uses a guarded login-shell fallback and negative-caches a failed probe', async () => {
    commandExecFileAsyncMock
      .mockRejectedValueOnce(new Error('login rc failed'))
      .mockResolvedValue({ stdout: 'fallback', stderr: '' })

    await expect(gitStatusExecFileAsync(['status'], wslOptions())).resolves.toEqual({
      stdout: 'fallback',
      stderr: ''
    })
    await gitStatusExecFileAsync(['status'], wslOptions())

    expect(commandExecFileAsyncMock).toHaveBeenCalledTimes(3)
    const fallbackArgs = commandExecFileAsyncMock.mock.calls[1][1] as string[]
    expect(fallbackArgs[4]).toBe('-lc')
    expect(fallbackArgs[5]).toContain(String.raw`GIT_OPTIONAL_LOCKS='\''0'\''`)
    expect(fallbackArgs[5]).toContain(String.raw`GIT_TERMINAL_PROMPT='\''0'\''`)
    expect(fallbackArgs[5]).toContain(String.raw`GIT_CONFIG_KEY_1='\''credential.guiPrompt'\''`)
  })

  it('invalidates a missing cached executable and retries once through login resolution', async () => {
    const unavailable = Object.assign(new Error('cached git missing'), {
      code: 127,
      stderr: 'orca-wsl-status-cached-git-unavailable:/usr/bin/git'
    })
    commandExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: probeOutput, stderr: '' })
      .mockResolvedValueOnce({ stdout: 'first', stderr: '' })
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce({ stdout: 'fallback', stderr: '' })
      .mockResolvedValueOnce({ stdout: probeOutput, stderr: '' })
      .mockResolvedValueOnce({ stdout: 'third', stderr: '' })

    await gitStatusExecFileAsync(['status'], wslOptions())
    await expect(gitStatusExecFileAsync(['status'], wslOptions())).resolves.toMatchObject({
      stdout: 'fallback'
    })
    await expect(gitStatusExecFileAsync(['status'], wslOptions())).resolves.toMatchObject({
      stdout: 'third'
    })

    expect(commandExecFileAsyncMock).toHaveBeenCalledTimes(6)
    expect((commandExecFileAsyncMock.mock.calls[3][1] as string[])[4]).toBe('-lc')
  })

  it('does not retry a genuine Git error', async () => {
    const gitError = Object.assign(new Error('fatal: bad revision'), {
      code: 128,
      stderr: 'fatal: bad revision'
    })
    commandExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: probeOutput, stderr: '' })
      .mockRejectedValueOnce(gitError)

    await expect(gitStatusExecFileAsync(['rev-list', 'bad'], wslOptions())).rejects.toBe(gitError)
    expect(commandExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('delegates native execution to the unchanged generic runner', async () => {
    stubPlatform('linux')
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'native', stderr: '' })

    await expect(gitStatusExecFileAsync(['status'], { cwd: '/repo' })).resolves.toMatchObject({
      stdout: 'native'
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['status'], { cwd: '/repo' })
    expect(commandExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
