import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  execFileAsyncMock,
  execFileMock,
  promisifyCustom,
  resolveWindowsPowerShellExecutablePathMock
} = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  execFileMock: vi.fn(),
  promisifyCustom: Symbol.for('nodejs.util.promisify.custom'),
  resolveWindowsPowerShellExecutablePathMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: Object.assign(execFileMock, {
    [promisifyCustom]: execFileAsyncMock
  })
}))

vi.mock('./relay-command-env', () => ({
  buildRelayCommandEnv: () => ({ PATH: 'C:\\Windows\\System32' })
}))

vi.mock('../shared/windows-powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: resolveWindowsPowerShellExecutablePathMock
}))

const { scanWindowsListeningPorts } = await import('./windows-port-scan')

describe('scanWindowsListeningPorts', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
    resolveWindowsPowerShellExecutablePathMock.mockReset()
    resolveWindowsPowerShellExecutablePathMock.mockImplementation((family: string) =>
      family === 'powershell.exe'
        ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
        : null
    )
  })

  it('bounds the PowerShell scan with the caller abort signal and timeout', async () => {
    const controller = new AbortController()
    execFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ host: '127.0.0.1', port: 5173, pid: 1234, processName: 'node' }),
      stderr: ''
    })

    await expect(scanWindowsListeningPorts(controller.signal)).resolves.toEqual([
      { host: '127.0.0.1', port: 5173, pid: 1234, processName: 'node' }
    ])

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      expect.arrayContaining(['-EncodedCommand', expect.any(String)]),
      expect.objectContaining({
        signal: controller.signal,
        timeout: 5000,
        windowsHide: true
      })
    )
  })

  it('bounds the netstat fallback with the same abort signal and timeout', async () => {
    const controller = new AbortController()
    execFileAsyncMock
      .mockRejectedValueOnce(new Error('powershell unavailable'))
      .mockResolvedValueOnce({
        stdout: [
          '  Proto  Local Address          Foreign Address        State           PID',
          '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       2468'
        ].join('\r\n'),
        stderr: ''
      })

    await expect(scanWindowsListeningPorts(controller.signal)).resolves.toEqual([
      { host: '0.0.0.0', port: 3000, pid: 2468 }
    ])

    expect(execFileAsyncMock).toHaveBeenLastCalledWith(
      'netstat.exe',
      ['-ano', '-p', 'tcp'],
      expect.objectContaining({
        signal: controller.signal,
        timeout: 5000,
        windowsHide: true
      })
    )
    expect(execFileAsyncMock).not.toHaveBeenCalledWith(
      'pwsh.exe',
      expect.any(Array),
      expect.any(Object)
    )
  })

  it('tries resolved PowerShell 7 before netstat when inbox PowerShell fails', async () => {
    resolveWindowsPowerShellExecutablePathMock.mockImplementation((family: string) =>
      family === 'powershell.exe'
        ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
        : 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    )
    execFileAsyncMock
      .mockRejectedValueOnce(new Error('powershell unavailable'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ host: '127.0.0.1', port: 9229, pid: 4321 }),
        stderr: ''
      })

    await expect(scanWindowsListeningPorts()).resolves.toEqual([
      { host: '127.0.0.1', port: 9229, pid: 4321 }
    ])

    expect(execFileAsyncMock.mock.calls[1]?.[0]).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
  })

  it('does not start the netstat fallback after the scan is cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    execFileAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('cancelled'), { name: 'AbortError' })
    )

    await expect(scanWindowsListeningPorts(controller.signal)).resolves.toEqual([])

    expect(execFileAsyncMock).toHaveBeenCalledTimes(1)
  })
})
