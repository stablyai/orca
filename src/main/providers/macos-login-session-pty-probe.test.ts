import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, existsSyncMock, stdinEndMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  existsSyncMock: vi.fn(),
  stdinEndMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))
vi.mock('node:fs', () => ({ existsSync: existsSyncMock }))

import { runMacosLoginSessionPtyProbe } from './macos-login-session-pty-probe'

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void

describe('runMacosLoginSessionPtyProbe', () => {
  beforeEach(() => {
    existsSyncMock.mockReturnValue(true)
    execFileMock.mockReset()
    stdinEndMock.mockReset()
  })

  it('runs login under expect-owned PTY and requires its marker plus a clean exit', async () => {
    const abortController = new AbortController()
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(null, '^D\b\bORCA_LOGIN_PREFLIGHT_OK', '')
        return { stdin: { end: stdinEndMock } }
      }
    )

    await expect(
      runMacosLoginSessionPtyProbe('ada', '/Users/ada', 4_000, 1_024, abortController.signal)
    ).resolves.toEqual({ ok: true, conclusive: true, reason: 'accepted' })
    expect(execFileMock).toHaveBeenCalledWith(
      '/usr/bin/expect',
      [
        '-c',
        expect.stringContaining(
          'spawn -noecho /usr/bin/login -flpq $env(ORCA_LOGIN_PROBE_USERNAME)'
        )
      ],
      expect.objectContaining({
        cwd: '/Users/ada',
        env: expect.objectContaining({ ORCA_LOGIN_PROBE_USERNAME: 'ada' }),
        killSignal: 'SIGKILL',
        maxBuffer: 1_024,
        signal: abortController.signal,
        timeout: 4_000
      }),
      expect.any(Function)
    )
    expect(stdinEndMock).toHaveBeenCalledOnce()
    expect(execFileMock.mock.calls[0]?.[1]?.[1]).toContain('send "\\004"; expect eof')
  })

  it('treats a natural exit without the marker as a conclusive rejection', async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(null, 'Login incorrect\r\nlogin: ', '')
        return { stdin: { end: stdinEndMock } }
      }
    )

    await expect(runMacosLoginSessionPtyProbe('ada', '/Users/ada', 4_000, 1_024)).resolves.toEqual({
      ok: false,
      conclusive: true,
      reason: 'rejected'
    })
  })

  it('keeps a timeout or output overflow inconclusive', async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(Object.assign(new Error('killed'), { killed: true }), '', '')
        return { stdin: { end: stdinEndMock } }
      }
    )
    await expect(runMacosLoginSessionPtyProbe('ada', '/Users/ada', 4_000, 1_024)).resolves.toEqual({
      ok: false,
      conclusive: false,
      reason: 'timeout'
    })

    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(
          Object.assign(new Error('stdout maxBuffer length exceeded'), {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          }),
          '',
          ''
        )
        return { stdin: { end: stdinEndMock } }
      }
    )
    await expect(runMacosLoginSessionPtyProbe('ada', '/Users/ada', 4_000, 1_024)).resolves.toEqual({
      ok: false,
      conclusive: false,
      reason: 'error'
    })
  })

  it('does not mistake an expect wrapper failure for a PAM rejection', async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(Object.assign(new Error('expect Tcl error'), { code: 1 }), '', '')
        return { stdin: { end: stdinEndMock } }
      }
    )

    await expect(runMacosLoginSessionPtyProbe('ada', '/Users/ada', 4_000, 1_024)).resolves.toEqual({
      ok: false,
      conclusive: false,
      reason: 'error'
    })
  })

  it('fails safe without spawning when expect is unavailable', async () => {
    existsSyncMock.mockReturnValue(false)

    await expect(runMacosLoginSessionPtyProbe('ada', '/Users/ada', 4_000, 1_024)).resolves.toEqual({
      ok: false,
      conclusive: false,
      reason: 'error'
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })
})
