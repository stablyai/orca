import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'
import { quoteWindowsCmdArgument } from '@orca/process-host/windows-command-line'
import type { VoiceCommandResult } from './voice-control-command-runner'

vi.mock('@orca/process-host', () => ({
  runProcess: vi.fn()
}))

import { runProcess } from '@orca/process-host'
import { formatVoiceCommandOutput, runVoiceCommand } from './voice-control-command-runner'

const originalPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
})

const runProcessMock = vi.mocked(runProcess)

function cleanResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    code: 0,
    signal: null,
    stdout: 'ok\n',
    stderr: '',
    timedOut: false,
    outputTruncated: false,
    ...overrides
  }
}

describe('runVoiceCommand', () => {
  beforeEach(() => {
    runProcessMock.mockReset()
    runProcessMock.mockResolvedValue(cleanResult())
  })

  it('runs the command through runProcess with timeout, cap, and a termination barrier', async () => {
    const result = await runVoiceCommand({ command: 'git status', cwd: '/tmp/x' })
    expect(runProcessMock).toHaveBeenCalledTimes(1)
    const [spec, capture] = runProcessMock.mock.calls[0] ?? []
    expect(capture).toBe('tail')
    expect(spec?.cwd).toBe('/tmp/x')
    expect(spec?.timeoutMs).toBe(15_000)
    expect(spec?.maxOutputBytes).toBe(64 * 1024)
    expect(spec?.killOnOutputLimit).toBe(true)
    expect(spec?.terminationBarrier).toBe(true)
    // POSIX shape: /bin/sh -c (the Windows shape is the cmd.exe /s branch).
    if (process.platform !== 'win32') {
      expect(spec?.program).toBe('/bin/sh')
      expect(spec?.args).toEqual(['-c', 'git status'])
    }
    expect(result).toEqual({
      exitCode: 0,
      stdout: 'ok\n',
      stderr: '',
      timedOut: false,
      truncated: false
    })
  })

  it('rejects a multi-line command without spawning anything', async () => {
    const result = await runVoiceCommand({ command: 'echo a\nrm -rf /', cwd: '/tmp/x' })
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(result.exitCode).toBeNull()
    expect(result.stderr).toContain('multi-line')
  })

  it('encodes the Windows line with the shared cmd encoder, not hand-rolled quoting', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    // Backslash-adjacent %VAR% and an embedded quote: the two shapes hand-rolled
    // quoting corrupts (escaped quote to CommandLineToArgvW; odd cmd quote count).
    const command = String.raw`cd %USERPROFILE%\src && echo "hi"`
    await runVoiceCommand({ command, cwd: 'C:\\x' })
    const [spec] = runProcessMock.mock.calls[0] ?? []
    expect(spec?.program).toBe(process.env.ComSpec ?? 'cmd.exe')
    expect(spec?.args).toEqual(['/d', '/v:off', '/s', '/c', quoteWindowsCmdArgument(command)])
    expect(spec?.windowsVerbatimArguments).toBe(true)
  })

  it('threads the abort signal through so a stopped session kills its commands', async () => {
    const controller = new AbortController()
    await runVoiceCommand({ command: 'sleep 5', cwd: '/tmp/x', signal: controller.signal })
    const [spec] = runProcessMock.mock.calls[0] ?? []
    expect(spec?.signal).toBe(controller.signal)
  })

  it('maps a timeout and truncation into the result as data, not an exception', async () => {
    runProcessMock.mockResolvedValue(
      cleanResult({ code: null, timedOut: true, outputTruncated: true })
    )
    const result = await runVoiceCommand({ command: 'yes', cwd: '/tmp/x' })
    expect(result.timedOut).toBe(true)
    expect(result.truncated).toBe(true)
    expect(result.exitCode).toBeNull()
  })
})

describe('formatVoiceCommandOutput', () => {
  const base: VoiceCommandResult = {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    truncated: false
  }

  it('renders stdout and the exit code', () => {
    const output = formatVoiceCommandOutput({ ...base, stdout: 'on branch main\n' })
    expect(output).toContain('on branch main')
    expect(output).toContain('exit code: 0')
  })

  it('notes a timeout before the output', () => {
    const output = formatVoiceCommandOutput({ ...base, timedOut: true, exitCode: null })
    expect(output).toContain('did not finish within 15 seconds')
    expect(output).toContain('exit code: none')
  })

  it('notes truncation and renders stderr explicitly', () => {
    const output = formatVoiceCommandOutput({
      ...base,
      truncated: true,
      stderr: 'boom',
      exitCode: 1
    })
    expect(output).toContain('truncated')
    expect(output).toContain('stderr: boom')
    expect(output).toContain('exit code: 1')
  })

  it('says so when the command produced nothing', () => {
    expect(formatVoiceCommandOutput(base)).toContain('no output')
  })
})
