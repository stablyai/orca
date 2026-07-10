import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileAsyncMock, execFileMock, promisifyCustom } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  execFileMock: vi.fn(),
  promisifyCustom: Symbol.for('nodejs.util.promisify.custom')
}))

vi.mock('child_process', () => ({
  execFile: Object.assign(execFileMock, {
    [promisifyCustom]: execFileAsyncMock
  })
}))

vi.mock('./relay-command-env', () => ({
  buildRelayCommandEnv: () => ({ PATH: 'C:\\Windows\\System32' })
}))

const { scanWindowsListeningPorts } = await import('./windows-port-scan')

describe('scanWindowsListeningPorts', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
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
      'powershell.exe',
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
      .mockRejectedValueOnce(new Error('pwsh unavailable'))
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
