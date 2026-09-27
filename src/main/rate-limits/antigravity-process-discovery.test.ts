import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

import { discoverAntigravityRuntime } from './antigravity-process-discovery'

type ProcessResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function ok(stdout: string): ProcessResult {
  return { code: 0, signal: null, stdout, stderr: '', timedOut: false }
}

function failed(): ProcessResult {
  return { code: 1, signal: null, stdout: '', stderr: 'boom', timedOut: false }
}

const REAL_ANTIGRAVITY_PROCESS_JSON = JSON.stringify({
  ProcessId: 78072,
  CommandLine:
    'C:\\Users\\dev\\AppData\\Local\\Programs\\Antigravity\\resources\\bin\\language_server.exe --standalone --override_ide_name antigravity --subclient_type hub --app_data_dir antigravity --https_server_port 0 --csrf_token 55c16ac6-c94a-4e80-aa28-9e82b1064747'
})

describe('discoverAntigravityRuntime (Windows)', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    runProcessMock.mockReset()
  })

  it('finds the running Antigravity language_server, its CSRF token, and its listening ports', async () => {
    runProcessMock
      .mockResolvedValueOnce(ok(REAL_ANTIGRAVITY_PROCESS_JSON))
      .mockResolvedValueOnce(ok(JSON.stringify([51365, 51364])))

    const runtime = await discoverAntigravityRuntime()

    expect(runtime).toEqual({
      pid: 78072,
      csrfToken: '55c16ac6-c94a-4e80-aa28-9e82b1064747',
      ports: [51365, 51364]
    })
    // Why: every spawn must go through the shared run-process chokepoint
    // (windowsHide + argv handling), never a direct child_process import.
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({ program: 'powershell.exe' })
    )
  })

  it('handles Get-CimInstance returning a bare object (single match) instead of an array', async () => {
    runProcessMock
      .mockResolvedValueOnce(ok(REAL_ANTIGRAVITY_PROCESS_JSON))
      .mockResolvedValueOnce(ok(JSON.stringify(51364)))

    const runtime = await discoverAntigravityRuntime()

    expect(runtime).toEqual({
      pid: 78072,
      csrfToken: '55c16ac6-c94a-4e80-aa28-9e82b1064747',
      ports: [51364]
    })
  })

  it('returns null when no language_server process is running at all', async () => {
    runProcessMock.mockResolvedValueOnce(ok('[]'))

    expect(await discoverAntigravityRuntime()).toBeNull()
  })

  it('ignores a language_server process that does not belong to Antigravity', async () => {
    runProcessMock.mockResolvedValueOnce(
      ok(
        JSON.stringify({
          ProcessId: 999,
          CommandLine: 'C:\\Some\\Other\\App\\language_server.exe --app_data_dir some-other-ide'
        })
      )
    )

    expect(await discoverAntigravityRuntime()).toBeNull()
  })

  it('returns null when the command line has no CSRF token', async () => {
    runProcessMock.mockResolvedValueOnce(
      ok(
        JSON.stringify({
          ProcessId: 78072,
          CommandLine:
            'C:\\...\\language_server.exe --app_data_dir antigravity --https_server_port 0'
        })
      )
    )

    expect(await discoverAntigravityRuntime()).toBeNull()
  })

  it('returns null when the process is found but has no listening ports', async () => {
    runProcessMock
      .mockResolvedValueOnce(ok(REAL_ANTIGRAVITY_PROCESS_JSON))
      .mockResolvedValueOnce(ok('[]'))

    expect(await discoverAntigravityRuntime()).toBeNull()
  })

  it('returns null when the PowerShell command itself fails', async () => {
    runProcessMock.mockResolvedValueOnce(failed())

    expect(await discoverAntigravityRuntime()).toBeNull()
  })

  it('returns null when run-process rejects (e.g. powershell.exe missing)', async () => {
    runProcessMock.mockRejectedValueOnce(new Error('spawn powershell.exe ENOENT'))

    expect(await discoverAntigravityRuntime()).toBeNull()
  })

  it('returns null on unparsable PowerShell output instead of throwing', async () => {
    runProcessMock.mockResolvedValueOnce(ok('not json at all'))

    expect(await discoverAntigravityRuntime()).toBeNull()
  })

  it('returns null when the command times out', async () => {
    runProcessMock.mockResolvedValueOnce({
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: true
    })

    expect(await discoverAntigravityRuntime()).toBeNull()
  })
})

describe('discoverAntigravityRuntime (macOS/Linux)', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    runProcessMock.mockReset()
  })

  it('finds the running Antigravity language_server via pgrep/lsof', async () => {
    runProcessMock
      .mockResolvedValueOnce(
        ok(
          '4242 /Applications/Antigravity.app/Contents/Resources/bin/language_server_macos --app_data_dir antigravity --csrf_token abc-123-def'
        )
      )
      .mockResolvedValueOnce(
        ok(
          'COMMAND     PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nlanguage 4242 dev  10u  IPv4  0x0      0t0  TCP 127.0.0.1:51364 (LISTEN)\n'
        )
      )

    const runtime = await discoverAntigravityRuntime()

    expect(runtime).toEqual({ pid: 4242, csrfToken: 'abc-123-def', ports: [51364] })
    expect(runProcessMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ program: 'pgrep' }))
  })

  it('returns null when pgrep finds no matching process (exit 1, empty stdout)', async () => {
    runProcessMock.mockResolvedValueOnce(failed())

    expect(await discoverAntigravityRuntime()).toBeNull()
  })
})
