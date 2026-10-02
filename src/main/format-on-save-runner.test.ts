import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProcessResult, ProcessSpec } from '../shared/child-process/run-process'
import type { WslResult, WslSpec } from './wsl/wsl-runner'

const runProcessMock = vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>()
const runWslProcessMock = vi.fn<(spec: WslSpec) => Promise<WslResult>>()

vi.mock('../shared/child-process/run-process', () => ({
  runProcess: (spec: ProcessSpec) => runProcessMock(spec)
}))

vi.mock('./wsl/wsl-runner', () => ({
  runWslProcess: (spec: WslSpec) => runWslProcessMock(spec)
}))

vi.mock('./wsl', () => ({
  parseWslPath: vi.fn(() => null),
  toLinuxPath: vi.fn((value: string) => value)
}))

import {
  _resetFormatOnSaveInFlightForTests,
  FORMAT_ON_SAVE_TIMEOUT_MS,
  runFormatOnSave
} from './format-on-save-runner'
import { parseWslPath } from './wsl'
import type { RepoFormatOnSaveSettings } from '../shared/repo-types'

const enabledSettings: RepoFormatOnSaveSettings = {
  enabled: true,
  command: 'prettier --write ${file}',
  include: ['**/*.ts']
}

const IS_WINDOWS_HOST = process.platform === 'win32'

/** Quotes a path the way the runner does on whichever host the suite runs on. */
function hostQuoted(value: string): string {
  return IS_WINDOWS_HOST ? `"${value}"` : `'${value}'`
}

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides }
}

function runProcessResolvesWith(code: number | null, stdout = '', stderr = ''): void {
  runProcessMock.mockResolvedValue(processResult({ code, stdout, stderr }))
}

/** A run that stays open until the returned callback settles it. */
function runProcessPending(): (result?: Partial<ProcessResult>) => void {
  let release: ((result: ProcessResult) => void) | undefined
  runProcessMock.mockImplementation(
    () =>
      new Promise<ProcessResult>((resolve) => {
        release = resolve
      })
  )
  return (result) => release?.(processResult(result))
}

function spawnedSpec(callIndex = 0): ProcessSpec {
  return runProcessMock.mock.calls[callIndex][0]
}

function spawnedCommand(callIndex = 0): string {
  const command = spawnedSpec(callIndex).args?.at(-1) ?? ''
  // Why: the Windows shell line wraps the whole command in the quotes `/s` strips.
  return IS_WINDOWS_HOST ? command.slice(1, -1) : command
}

beforeEach(() => {
  runProcessMock.mockReset()
  runWslProcessMock.mockReset()
  _resetFormatOnSaveInFlightForTests()
  vi.mocked(parseWslPath).mockReturnValue(null)
  runProcessResolvesWith(0)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('runFormatOnSave', () => {
  it('skips when the repo has no formatter configured', async () => {
    await expect(
      runFormatOnSave({
        settings: { enabled: false, command: '', include: [] },
        worktreePath: '/repo',
        absoluteFilePath: '/repo/src/a.ts'
      })
    ).resolves.toEqual({ status: 'skipped', reason: 'not-configured' })
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('skips files the include globs do not cover', async () => {
    await expect(
      runFormatOnSave({
        settings: enabledSettings,
        worktreePath: '/repo',
        absoluteFilePath: '/repo/src/a.css'
      })
    ).resolves.toEqual({ status: 'skipped', reason: 'not-included' })
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('refuses to format a file outside the worktree', async () => {
    await expect(
      runFormatOnSave({
        settings: enabledSettings,
        worktreePath: '/repo',
        absoluteFilePath: '/elsewhere/src/a.ts'
      })
    ).resolves.toEqual({ status: 'skipped', reason: 'outside-worktree' })
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('refuses a dot-dot path that textually starts inside the worktree', async () => {
    await expect(
      runFormatOnSave({
        settings: enabledSettings,
        worktreePath: '/repo',
        absoluteFilePath: '/repo/../elsewhere/a.ts'
      })
    ).resolves.toEqual({ status: 'skipped', reason: 'outside-worktree' })
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('fails without spawning when a path cannot be quoted safely for the remote shell', async () => {
    const remoteExec = vi.fn()
    await expect(
      runFormatOnSave({
        settings: enabledSettings,
        worktreePath: 'C:\\repo',
        absoluteFilePath: 'C:\\repo\\src\\%USERNAME%.ts',
        remoteExec
      })
    ).resolves.toMatchObject({ status: 'failed', message: expect.stringContaining('cmd.exe') })
    expect(remoteExec).not.toHaveBeenCalled()
  })

  it('runs the command in the worktree root with the saved path substituted', async () => {
    await runFormatOnSave({
      settings: enabledSettings,
      worktreePath: '/repo',
      absoluteFilePath: '/repo/src/a.ts'
    })

    // Why: quoting follows the host shell, so derive the expectation instead of
    // hardcoding POSIX quotes — this suite also runs on Windows CI.
    expect(spawnedCommand()).toBe(`prettier --write ${hostQuoted('/repo/src/a.ts')}`)
    expect(spawnedSpec().cwd).toBe('/repo')
  })

  it('hands cmd.exe the whole command line verbatim on Windows', async () => {
    const platform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      await runFormatOnSave({
        settings: enabledSettings,
        worktreePath: 'C:\\repo',
        absoluteFilePath: 'C:\\repo\\src\\a.ts'
      })
    } finally {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    }

    expect(spawnedSpec()).toMatchObject({
      args: ['/d', '/s', '/c', '"prettier --write "C:\\repo\\src\\a.ts""'],
      windowsVerbatimArguments: true,
      cwd: 'C:\\repo'
    })
  })

  it('reports the formatter stderr when the command exits non-zero', async () => {
    runProcessResolvesWith(1, '', 'SyntaxError: Unexpected token (3:1)')

    await expect(
      runFormatOnSave({
        settings: enabledSettings,
        worktreePath: '/repo',
        absoluteFilePath: '/repo/src/a.ts'
      })
    ).resolves.toEqual({
      status: 'failed',
      message: 'SyntaxError: Unexpected token (3:1)'
    })
  })

  it('reports the process error when the formatter cannot be started', async () => {
    runProcessMock.mockRejectedValue(new Error('spawn /bin/bash ENOENT'))

    await expect(
      runFormatOnSave({
        settings: enabledSettings,
        worktreePath: '/repo',
        absoluteFilePath: '/repo/src/a.ts'
      })
    ).resolves.toEqual({ status: 'failed', message: 'spawn /bin/bash ENOENT' })
  })

  it('names the exit code when a failing formatter prints nothing', async () => {
    runProcessResolvesWith(2)

    await expect(
      runFormatOnSave({
        settings: enabledSettings,
        worktreePath: '/repo',
        absoluteFilePath: '/repo/src/a.ts'
      })
    ).resolves.toEqual({ status: 'failed', message: 'Formatter exited with code 2.' })
  })

  it('falls back to stdout when the formatter reports its error there', async () => {
    runProcessResolvesWith(1, 'error on stdout', '  ')

    await expect(
      runFormatOnSave({
        settings: enabledSettings,
        worktreePath: '/repo',
        absoluteFilePath: '/repo/src/a.ts'
      })
    ).resolves.toEqual({ status: 'failed', message: 'error on stdout' })
  })

  it('skips a second run while the same file is still being formatted', async () => {
    const release = runProcessPending()

    const first = runFormatOnSave({
      settings: enabledSettings,
      worktreePath: '/repo',
      absoluteFilePath: '/repo/src/a.ts'
    })
    await vi.waitFor(() => expect(runProcessMock).toHaveBeenCalled())

    await expect(
      runFormatOnSave({
        settings: enabledSettings,
        worktreePath: '/repo',
        absoluteFilePath: '/repo/src/a.ts'
      })
    ).resolves.toEqual({ status: 'skipped', reason: 'already-running' })

    release()
    await expect(first).resolves.toEqual({ status: 'completed' })
    expect(runProcessMock).toHaveBeenCalledTimes(1)
  })

  it('frees the in-flight slot after a failed run so the next save can format', async () => {
    runProcessResolvesWith(1, '', 'boom')
    await runFormatOnSave({
      settings: enabledSettings,
      worktreePath: '/repo',
      absoluteFilePath: '/repo/src/a.ts'
    })

    runProcessResolvesWith(0)
    await expect(
      runFormatOnSave({
        settings: enabledSettings,
        worktreePath: '/repo',
        absoluteFilePath: '/repo/src/a.ts'
      })
    ).resolves.toEqual({ status: 'completed' })
  })

  it('keeps posix paths case-sensitive so two real files never share a slot', async () => {
    const anyFile = { ...enabledSettings, include: [] }

    await runFormatOnSave({
      settings: anyFile,
      worktreePath: '/repo',
      absoluteFilePath: '/repo/src/a.ts'
    })
    await runFormatOnSave({
      settings: anyFile,
      worktreePath: '/repo',
      absoluteFilePath: '/repo/src/A.TS'
    })

    expect(runProcessMock).toHaveBeenCalledTimes(2)
  })

  it('does not report a chatty but successful formatter as failed', async () => {
    // Why: `black --verbose` and `prettier --loglevel debug` succeed while
    // printing megabytes; output volume must not turn into an error.
    runProcessMock.mockResolvedValue(
      processResult({ stdout: 'x'.repeat(1024), stderr: 'y'.repeat(1024), outputTruncated: true })
    )

    await expect(
      runFormatOnSave({
        settings: enabledSettings,
        worktreePath: '/repo',
        absoluteFilePath: '/repo/src/a.ts'
      })
    ).resolves.toEqual({ status: 'completed' })
    expect(spawnedSpec().maxOutputBytes).toBe(1024 * 1024)
  })

  it('kills the whole process tree and reports a timeout', async () => {
    const release = runProcessPending()

    const pending = runFormatOnSave({
      settings: enabledSettings,
      worktreePath: '/repo',
      absoluteFilePath: '/repo/src/a.ts'
    })
    // Why: the shell alone dying leaves `npx prettier` running to overwrite a later save.
    await vi.waitFor(() => expect(runProcessMock).toHaveBeenCalled())
    expect(spawnedSpec()).toMatchObject({
      timeoutMs: FORMAT_ON_SAVE_TIMEOUT_MS,
      terminationBarrier: true
    })

    release({ code: null, signal: 'SIGKILL', timedOut: true })
    await expect(pending).resolves.toMatchObject({
      status: 'failed',
      message: expect.stringContaining('timed out')
    })
  })

  it('holds the in-flight slot until a timed-out formatter is confirmed gone', async () => {
    const release = runProcessPending()
    const first = runFormatOnSave({
      settings: enabledSettings,
      worktreePath: '/repo',
      absoluteFilePath: '/repo/src/a.ts'
    })
    await vi.waitFor(() => expect(runProcessMock).toHaveBeenCalled())

    await expect(
      runFormatOnSave({
        settings: enabledSettings,
        worktreePath: '/repo',
        absoluteFilePath: '/repo/src/a.ts'
      })
    ).resolves.toEqual({ status: 'skipped', reason: 'already-running' })

    release({ code: null, timedOut: true })
    await first

    runProcessResolvesWith(0)
    await expect(
      runFormatOnSave({
        settings: enabledSettings,
        worktreePath: '/repo',
        absoluteFilePath: '/repo/src/a.ts'
      })
    ).resolves.toEqual({ status: 'completed' })
  })

  it('names the signal when a formatter is killed without a timeout', async () => {
    runProcessMock.mockResolvedValue(processResult({ code: null, signal: 'SIGSEGV' }))

    await expect(
      runFormatOnSave({
        settings: enabledSettings,
        worktreePath: '/repo',
        absoluteFilePath: '/repo/src/a.ts'
      })
    ).resolves.toEqual({ status: 'failed', message: 'Formatter was stopped by SIGSEGV.' })
  })

  it('shares one in-flight slot across differently-cased windows paths', async () => {
    // Why: Windows resolves paths case-insensitively, so two tabs on the same
    // file would otherwise run the formatter over each other's output.
    const release = runProcessPending()

    // Why: include globs stay case-sensitive like every other glob matcher, so
    // this case tests the in-flight key alone.
    const anyFile = { ...enabledSettings, include: [] }
    const first = runFormatOnSave({
      settings: anyFile,
      worktreePath: 'C:\\repo',
      absoluteFilePath: 'C:\\repo\\src\\a.ts'
    })
    await vi.waitFor(() => expect(runProcessMock).toHaveBeenCalled())

    await expect(
      runFormatOnSave({
        settings: anyFile,
        worktreePath: 'C:\\repo',
        absoluteFilePath: 'C:\\repo\\src\\A.TS'
      })
    ).resolves.toEqual({ status: 'skipped', reason: 'already-running' })

    release?.()
    await expect(first).resolves.toEqual({ status: 'completed' })
    expect(runProcessMock).toHaveBeenCalledTimes(1)
  })

  it('runs the formatter on the remote host for an SSH worktree', async () => {
    const remoteExec = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false
    })

    await expect(
      runFormatOnSave({
        settings: enabledSettings,
        worktreePath: '/srv/repo',
        absoluteFilePath: '/srv/repo/src/a.ts',
        remoteExec,
        hostScope: 'ssh-1'
      })
    ).resolves.toEqual({ status: 'completed' })

    expect(remoteExec).toHaveBeenCalledWith({
      binary: '/bin/bash',
      args: ['-lc', "prettier --write '/srv/repo/src/a.ts'"],
      cwd: '/srv/repo',
      timeoutMs: expect.any(Number)
    })
    // Why: the local shell must not be touched for a file that lives elsewhere.
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('uses cmd.exe when the SSH host is Windows', async () => {
    const remoteExec = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false
    })

    await runFormatOnSave({
      settings: { ...enabledSettings, include: [] },
      worktreePath: 'C:\\srv\\repo',
      absoluteFilePath: 'C:\\srv\\repo\\src\\a.ts',
      remoteExec,
      hostScope: 'ssh-win'
    })

    const call = remoteExec.mock.calls[0][0]
    expect(call.binary).toBe('cmd.exe')
    expect(call.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(call.args[3]).toContain('"C:\\srv\\repo\\src\\a.ts"')
  })

  it('reports a remote formatter failure with its stderr', async () => {
    const remoteExec = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: 'SyntaxError: line 3',
      exitCode: 2,
      timedOut: false
    })

    await expect(
      runFormatOnSave({
        settings: enabledSettings,
        worktreePath: '/srv/repo',
        absoluteFilePath: '/srv/repo/src/a.ts',
        remoteExec,
        hostScope: 'ssh-1'
      })
    ).resolves.toEqual({ status: 'failed', message: 'SyntaxError: line 3' })
  })

  it('names a remote timeout and a remote spawn failure distinctly', async () => {
    const timedOut = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: true
    })
    await expect(
      runFormatOnSave({
        settings: enabledSettings,
        worktreePath: '/srv/repo',
        absoluteFilePath: '/srv/repo/src/a.ts',
        remoteExec: timedOut,
        hostScope: 'ssh-1'
      })
    ).resolves.toMatchObject({ status: 'failed', message: expect.stringContaining('timed out') })

    const spawnFailed = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      spawnError: 'bash: not found'
    })
    await expect(
      runFormatOnSave({
        settings: enabledSettings,
        worktreePath: '/srv/repo',
        absoluteFilePath: '/srv/repo/src/a.ts',
        remoteExec: spawnFailed,
        hostScope: 'ssh-1'
      })
    ).resolves.toEqual({ status: 'failed', message: 'bash: not found' })
  })

  it('treats a dropped relay as a skip, not a formatter failure', async () => {
    // Why: the save already landed; a transport error must not read as the
    // formatter rejecting the user's file.
    const remoteExec = vi.fn().mockRejectedValue(new Error('relay disconnected'))

    await expect(
      runFormatOnSave({
        settings: enabledSettings,
        worktreePath: '/srv/repo',
        absoluteFilePath: '/srv/repo/src/a.ts',
        remoteExec,
        hostScope: 'ssh-1'
      })
    ).resolves.toEqual({ status: 'skipped', reason: 'unsupported-host' })
  })

  it('keeps in-flight slots separate per host for an identical path', async () => {
    let releaseFirst: (() => void) | undefined
    const slowRemote = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve({ stdout: '', stderr: '', exitCode: 0, timedOut: false })
        })
    )
    const fastRemote = vi
      .fn()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, timedOut: false })

    const first = runFormatOnSave({
      settings: enabledSettings,
      worktreePath: '/srv/repo',
      absoluteFilePath: '/srv/repo/src/a.ts',
      remoteExec: slowRemote,
      hostScope: 'ssh-1'
    })

    await expect(
      runFormatOnSave({
        settings: enabledSettings,
        worktreePath: '/srv/repo',
        absoluteFilePath: '/srv/repo/src/a.ts',
        remoteExec: fastRemote,
        hostScope: 'ssh-2'
      })
    ).resolves.toEqual({ status: 'completed' })

    releaseFirst?.()
    await expect(first).resolves.toEqual({ status: 'completed' })
  })

  describe('WSL worktrees', () => {
    const wslRequest = {
      settings: enabledSettings,
      worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
      absoluteFilePath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo\\src\\a.ts'
    }

    function wslResult(overrides: Partial<WslResult> = {}): WslResult {
      return {
        environmentResolved: true,
        code: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        ...overrides
      }
    }

    beforeEach(() => {
      vi.mocked(parseWslPath).mockReturnValue({ distro: 'Ubuntu', linuxPath: '/home/dev/repo' })
      runWslProcessMock.mockResolvedValue(wslResult())
    })

    it('runs the formatter inside the distro with linux paths', async () => {
      await expect(runFormatOnSave(wslRequest)).resolves.toEqual({ status: 'completed' })

      expect(runWslProcessMock).toHaveBeenCalledWith({
        distro: 'Ubuntu',
        script: expect.stringContaining('prettier --write'),
        shell: 'bash',
        cwd: '/home/dev/repo',
        loginPath: 'preferred',
        timeoutMs: FORMAT_ON_SAVE_TIMEOUT_MS,
        maxOutputBytes: 1024 * 1024
      })
      expect(runProcessMock).not.toHaveBeenCalled()
    })

    it('reports the guest formatter stderr, a timeout, and a clipped success', async () => {
      runWslProcessMock.mockResolvedValueOnce(wslResult({ code: 1, stderr: 'SyntaxError: line 3' }))
      await expect(runFormatOnSave(wslRequest)).resolves.toEqual({
        status: 'failed',
        message: 'SyntaxError: line 3'
      })

      runWslProcessMock.mockResolvedValueOnce(wslResult({ code: null, timedOut: true }))
      await expect(runFormatOnSave(wslRequest)).resolves.toMatchObject({
        status: 'failed',
        message: expect.stringContaining('timed out')
      })

      // Why: output above the cap is clipped by the runner, never turned into a failure.
      runWslProcessMock.mockResolvedValueOnce(wslResult({ stdout: 'x'.repeat(2048) }))
      await expect(runFormatOnSave(wslRequest)).resolves.toEqual({ status: 'completed' })
    })

    it('reports a wsl.exe that cannot start as a formatter failure', async () => {
      runWslProcessMock.mockRejectedValueOnce(new Error('spawn wsl.exe ENOENT'))
      await expect(runFormatOnSave(wslRequest)).resolves.toEqual({
        status: 'failed',
        message: 'spawn wsl.exe ENOENT'
      })
    })
  })
})
