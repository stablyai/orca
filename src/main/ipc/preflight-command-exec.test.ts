import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import type * as LocalCommandResolver from './command-path-resolver'
import { buildPosixCommandPathLookupScript } from '../../shared/posix-command-path-lookup'

const {
  runPreflightCommandInWslMock,
  execFileAsyncMock,
  listLocalCommandPathsMock,
  runProcessMock
} = vi.hoisted(() => ({
  runPreflightCommandInWslMock: vi.fn(),
  execFileAsyncMock: vi.fn(),
  listLocalCommandPathsMock: vi.fn(),
  runProcessMock: vi.fn()
}))

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

vi.mock('./preflight-local-env', () => ({ buildLocalPreflightEnv: () => undefined }))

vi.mock('./preflight-wsl-command', () => ({
  runPreflightCommandInWsl: runPreflightCommandInWslMock
}))

vi.mock('./command-path-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof LocalCommandResolver>()),
  isCommandOnLocalPath: vi.fn(async () => false),
  listLocalCommandPaths: listLocalCommandPathsMock
}))

// Why: `findRunnableLocalCommand` decides what to spawn next from the error
// `execFile` puts on a failed probe, so the shapes below have to be its own.
vi.mock('child_process', () => {
  const execFileWithPromisify = Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: execFileAsyncMock
  })
  return { execFile: execFileWithPromisify, spawn: vi.fn() }
})

import { findRunnableLocalCommand, isCommandOnPath } from './preflight-command-exec'

describe('isCommandOnPath', () => {
  const sentinel = '__ORCA_PREFLIGHT_COMMAND_PATH__'

  beforeEach(() => {
    runPreflightCommandInWslMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses the shared literal lookup and accepts a sentinel-prefixed POSIX path', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    runPreflightCommandInWslMock.mockResolvedValue({
      stdout: `shell startup chatter\n${sentinel}/home/user/.local/bin/codex\n`,
      stderr: ''
    })

    const found = await isCommandOnPath('codex', { distro: 'Ubuntu' })

    expect(found).toBe(true)
    expect(runPreflightCommandInWslMock).toHaveBeenCalledOnce()
    const [, command] = runPreflightCommandInWslMock.mock.calls[0] as [{ distro: string }, string]
    expect(command).toContain(
      buildPosixCommandPathLookupScript(
        { kind: 'literal', value: 'codex' },
        // The WSL branch skips Windows mounts, so detection and this check
        // cannot disagree about the same distro.
        { skipWindowsMountDirs: true }
      )
    )
    expect(command).toContain(
      ['if [ -n "$resolved" ]; then', `printf '${sentinel}%s\\n' "$resolved"`, 'fi'].join('\n')
    )
  })

  it.each([
    ['/absolute/startup/chatter', false],
    [`${sentinel}relative/path`, false],
    ['codex', false],
    ["alias codex='codex --wrapped'", false]
  ])('parses WSL lookup output %s as available: %s', async (stdout, expected) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    runPreflightCommandInWslMock.mockResolvedValue({ stdout: `${stdout}\n`, stderr: '' })

    await expect(isCommandOnPath('codex', { distro: 'Ubuntu' })).resolves.toBe(expected)
  })
})

describe('findRunnableLocalCommand', () => {
  const shim = '/Users/tester/.asdf/shims/gh'
  const second = '/Users/tester/.volta/bin/gh'
  const third = '/usr/local/bin/gh'

  const spawnedCommands = () => execFileAsyncMock.mock.calls.map(([command]) => command)

  let pathBefore = ''

  beforeEach(() => {
    pathBefore = process.env.PATH ?? ''
    execFileAsyncMock.mockReset()
    runProcessMock.mockReset()
    listLocalCommandPathsMock.mockReset()
    listLocalCommandPathsMock.mockResolvedValue([shim, second, third])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.env.PATH = pathBefore
  })

  it('returns the first copy that runs and leaves the rest alone', async () => {
    execFileAsyncMock.mockImplementation(async (command: string) => {
      if (command === shim) {
        throw Object.assign(new Error('cannot execute'), { code: 126 })
      }
      return { stdout: 'gh version 2.98.0\n', stderr: '' }
    })

    await expect(findRunnableLocalCommand('gh')).resolves.toEqual({
      status: 'available',
      binary: second
    })
    expect(spawnedCommands()).toEqual([shim, second])
  })

  it('keeps looking when a copy exits non-zero', async () => {
    execFileAsyncMock.mockImplementation(async (command: string) => {
      if (command === third) {
        return { stdout: 'gh version 2.98.0\n', stderr: '' }
      }
      throw Object.assign(new Error('Command failed'), { code: 1 })
    })

    await expect(findRunnableLocalCommand('gh')).resolves.toEqual({
      status: 'available',
      binary: third
    })
  })

  it('stops at a timed-out copy instead of paying the timeout once per copy', async () => {
    execFileAsyncMock.mockImplementation(async (command: string) => {
      if (command === second) {
        throw Object.assign(new Error('Timed out'), { killed: true, code: null })
      }
      throw Object.assign(new Error('cannot execute'), { code: 126 })
    })

    await expect(findRunnableLocalCommand('gh')).resolves.toEqual({
      status: 'timeout',
      binary: second
    })
    expect(spawnedCommands()).toEqual([shim, second])
  })

  it('stops on the ETIMEDOUT shape as well as the killed shape', async () => {
    execFileAsyncMock.mockImplementation((command: string) =>
      command === second
        ? Promise.reject(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' }))
        : Promise.reject(Object.assign(new Error('cannot execute'), { code: 126 }))
    )

    await expect(findRunnableLocalCommand('gh')).resolves.toEqual({
      status: 'timeout',
      binary: second
    })
    expect(spawnedCommands()).toEqual([shim, second])
  })

  it('reads a rejection that is not an object as an ordinary failure', async () => {
    execFileAsyncMock.mockImplementation((command: string) =>
      command === third
        ? Promise.resolve({ stdout: 'gh version 2.98.0\n', stderr: '' })
        : Promise.reject('not an error object')
    )

    await expect(findRunnableLocalCommand('gh')).resolves.toEqual({
      status: 'available',
      binary: third
    })
    expect(spawnedCommands()).toEqual([shim, second, third])
  })

  it('probes the bare command name when fs finds no candidate', async () => {
    listLocalCommandPathsMock.mockResolvedValue([])
    execFileAsyncMock.mockResolvedValue({ stdout: 'gh version 2.98.0\n', stderr: '' })

    await expect(findRunnableLocalCommand('gh')).resolves.toEqual({
      status: 'available',
      binary: 'gh'
    })
    expect(spawnedCommands()).toEqual(['gh'])
  })

  it('probes a relative PATH entry as the absolute directory cwd gives it', async () => {
    const relativeDir = path.join('.', 'tools')
    process.env.PATH = [shim.replace('/gh', ''), relativeDir].join(path.delimiter)
    const absoluteDir = path.resolve(relativeDir)
    const hidden = `${absoluteDir}/gh`
    const absolutePath = [shim.replace('/gh', ''), absoluteDir].join(path.delimiter)
    listLocalCommandPathsMock.mockImplementation(
      async (_command: string, options?: { env?: NodeJS.ProcessEnv }) =>
        options?.env?.PATH === absolutePath ? [shim, hidden] : []
    )
    execFileAsyncMock.mockImplementation(async (command: string) => {
      if (command === hidden) {
        return { stdout: 'gh version 2.98.0\n', stderr: '' }
      }
      throw Object.assign(new Error('cannot execute'), { code: 126 })
    })

    await expect(findRunnableLocalCommand('gh')).resolves.toEqual({
      status: 'available',
      binary: hidden
    })
    expect(spawnedCommands()).toEqual([shim, hidden])
  })

  it('does not pay for the bare name when every PATH entry is absolute', async () => {
    process.env.PATH = ['/Users/tester/.asdf/shims', '/usr/local/bin'].join(path.delimiter)
    execFileAsyncMock.mockRejectedValue(Object.assign(new Error('cannot execute'), { code: 126 }))

    await expect(findRunnableLocalCommand('gh')).resolves.toEqual({
      status: 'exec_failed',
      binary: third
    })
    expect(spawnedCommands()).not.toContain('gh')
  })

  it('runs an explicitly selected Windows cmd shim through the shared runner', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const command = path.win32.join('C:\\tools', 'gh.cmd')
    runProcessMock.mockResolvedValue({
      code: 0,
      stdout: 'gh version fixture',
      stderr: '',
      timedOut: false
    })

    await expect(findRunnableLocalCommand(command)).resolves.toEqual({
      status: 'available',
      binary: command
    })
    expect(runProcessMock).toHaveBeenCalledWith({
      program: command,
      args: ['--version'],
      env: undefined,
      timeoutMs: expect.any(Number)
    })
    expect(execFileAsyncMock).not.toHaveBeenCalled()
    expect(listLocalCommandPathsMock).not.toHaveBeenCalled()
  })

  it('keeps searching Windows PATH after a broken cmd shim', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const command = path.win32.join('C:\\tools', 'gh.cmd')
    const working = path.win32.join('C:\\working', 'gh.exe')
    listLocalCommandPathsMock.mockResolvedValue([command, working])
    runProcessMock.mockResolvedValue({
      code: 126,
      stdout: '',
      stderr: 'broken shim',
      timedOut: false
    })
    execFileAsyncMock.mockResolvedValue({ stdout: 'gh version fixture', stderr: '' })

    await expect(findRunnableLocalCommand('gh')).resolves.toEqual({
      status: 'available',
      binary: working
    })
    expect(runProcessMock).toHaveBeenCalledOnce()
    expect(spawnedCommands()).toEqual([working])
  })

  it('stops on a shared runner timeout', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const command = path.win32.join('C:\\tools', 'gh.cmd')
    listLocalCommandPathsMock.mockResolvedValue([command, third])
    runProcessMock.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true })

    await expect(findRunnableLocalCommand('gh')).resolves.toEqual({
      status: 'timeout',
      binary: command
    })
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('shares the five second timeout across failed candidates', async () => {
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    execFileAsyncMock.mockImplementation(async (command: string) => {
      if (command === shim) {
        now += 4000
        throw Object.assign(new Error('cannot execute'), { code: 126 })
      }
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
    })

    await expect(findRunnableLocalCommand('gh')).resolves.toEqual({
      status: 'timeout',
      binary: second
    })
    expect(execFileAsyncMock.mock.calls.map(([, , options]) => options.timeout)).toEqual([
      5000, 1000
    ])
  })
})
