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

import { glabExecFileAsync, setDefaultWslDistroOverride } from './runner'

const PORTED_HOST = 'gitlab.internal:8443'

function execFileCall(index: number): {
  binary: string
  args: string[]
  env: NodeJS.ProcessEnv
} {
  const [binary, args, options] = execFileMock.mock.calls[index] as [
    string,
    string[],
    { env?: NodeJS.ProcessEnv }
  ]
  return { binary, args, env: options.env ?? {} }
}

function wslEnvNames(env: NodeJS.ProcessEnv): string[] {
  return (env.WSLENV ?? '').split(':').filter(Boolean)
}

function resolveOk(): void {
  execFileMock.mockImplementation((_binary, _args, _options, callback) => {
    callback(null, { stdout: '{}', stderr: '' })
  })
}

// Why: `--hostname host:port` is stripped for glab, so if GITLAB_HOST does not
// cross into the distro the call reaches WSL carrying no host at all.
describe('glab ported-host forwarding into WSL', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    execFileMock.mockReset()
    spawnMock.mockReset()
    getDefaultWslDistroMock.mockReset()
    getDefaultWslDistroMock.mockReturnValue(null)
    setDefaultWslDistroOverride(null)
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  // Why: a local WSL workspace routes by distro on the first attempt — no
  // host-missing fallback involved, so this path is not SSH-only.
  it('forwards GITLAB_HOST to a distro-routed glab on the first attempt', async () => {
    resolveOk()

    await glabExecFileAsync(['api', '--hostname', PORTED_HOST, 'projects/g%2Fp/issues/9'], {
      cwd: String.raw`C:\repo`,
      wslDistro: 'Ubuntu'
    })

    expect(execFileMock).toHaveBeenCalledTimes(1)
    const { binary, args, env } = execFileCall(0)
    expect(binary).toBe('wsl.exe')
    expect(args).not.toContain('--hostname')
    expect(env.GITLAB_HOST).toBe(PORTED_HOST)
    expect(wslEnvNames(env)).toContain('GITLAB_HOST')
  })

  it('forwards GITLAB_HOST when a UNC workspace cwd alone routes glab into WSL', async () => {
    resolveOk()

    await glabExecFileAsync(['api', '--hostname', PORTED_HOST, 'projects/g%2Fp/issues/9'], {
      cwd: String.raw`\\wsl.localhost\Ubuntu\home\me\repo`
    })

    expect(execFileMock).toHaveBeenCalledTimes(1)
    const { binary, env } = execFileCall(0)
    expect(binary).toBe('wsl.exe')
    expect(env.GITLAB_HOST).toBe(PORTED_HOST)
    expect(wslEnvNames(env)).toContain('GITLAB_HOST')
  })

  it('forwards GITLAB_HOST through the default-distro fallback for cwd-less calls', async () => {
    getDefaultWslDistroMock.mockReturnValue('Ubuntu')
    execFileMock
      .mockImplementationOnce((_binary, _args, _options, callback) => {
        callback(Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' }))
      })
      .mockImplementationOnce((_binary, _args, _options, callback) => {
        callback(null, { stdout: '{}', stderr: '' })
      })

    await glabExecFileAsync(['api', '--hostname', PORTED_HOST, 'user'])

    const { binary, args, env } = execFileCall(1)
    expect(binary).toBe('wsl.exe')
    expect(args).toEqual(['-d', 'Ubuntu', '--', 'bash', '-c', "'glab' 'api' 'user'"])
    expect(env.GITLAB_HOST).toBe(PORTED_HOST)
    expect(wslEnvNames(env)).toContain('GITLAB_HOST')
  })

  // Why: clobbering WSLENV would drop the git-auth entry the same spawn relies on.
  it('keeps an existing WSLENV entry when adding GITLAB_HOST', async () => {
    resolveOk()

    await glabExecFileAsync(['auth', 'status', '--hostname', PORTED_HOST], {
      cwd: String.raw`C:\repo`,
      wslDistro: 'Ubuntu',
      env: { WSLENV: 'GIT_SSH_COMMAND' }
    })

    const { env } = execFileCall(0)
    expect(wslEnvNames(env)).toEqual(['GIT_SSH_COMMAND', 'GITLAB_HOST'])
  })

  it('leaves a port-less hostname on the command line', async () => {
    resolveOk()

    await glabExecFileAsync(['api', '--hostname', 'gitlab.internal', 'user'], {
      cwd: String.raw`C:\repo`,
      wslDistro: 'Ubuntu'
    })

    const { args, env } = execFileCall(0)
    expect(args.at(-1)).toContain("'--hostname' 'gitlab.internal'")
    expect(env.GITLAB_HOST).toBeUndefined()
  })
})
