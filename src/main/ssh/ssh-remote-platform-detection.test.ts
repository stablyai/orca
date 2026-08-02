import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'

const execCommandMock = vi.hoisted(() => vi.fn())

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: execCommandMock
}))

const { detectRemoteHostPlatform } = await import('./ssh-remote-platform-detection')

const conn = {} as SshConnection

function decodePowerShellCommand(command: string): string {
  const match = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)
  return match ? Buffer.from(match[1], 'base64').toString('utf16le') : ''
}

describe('detectRemoteHostPlatform', () => {
  beforeEach(() => {
    execCommandMock.mockReset()
  })

  it('detects POSIX hosts from uname output', async () => {
    execCommandMock.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux   x86_64\n')

    await expect(detectRemoteHostPlatform(conn)).resolves.toMatchObject({
      relayPlatform: 'linux-x64',
      os: 'linux',
      arch: 'x64',
      pathFlavor: 'posix'
    })
    expect(execCommandMock).toHaveBeenCalledWith(
      conn,
      "printf '\\n%s ' '__ORCA_REMOTE_PLATFORM__'; uname -sm"
    )
  })

  it('falls back to PowerShell detection for Windows remotes', async () => {
    execCommandMock
      .mockRejectedValueOnce(new Error('uname unavailable'))
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Windows AMD64\r\n')

    await expect(detectRemoteHostPlatform(conn)).resolves.toMatchObject({
      relayPlatform: 'win32-x64',
      os: 'win32',
      arch: 'x64',
      pathFlavor: 'windows'
    })
    expect(execCommandMock).toHaveBeenNthCalledWith(
      2,
      conn,
      expect.stringContaining('powershell.exe'),
      { wrapCommand: false }
    )
    const command = execCommandMock.mock.calls[1]?.[1] ?? ''
    expect(decodePowerShellCommand(command)).toContain(
      'Write-Output ("`n__ORCA_REMOTE_PLATFORM__ Windows " + $arch)'
    )
  })

  it('ignores untagged platforms before the tagged Windows ARM64 result', async () => {
    execCommandMock
      .mockRejectedValueOnce(new Error('uname unavailable'))
      .mockResolvedValueOnce(
        'Linux x86_64\r\nWindows AMD64\r\n#< CLIXML\r\n' +
          '__ORCA_REMOTE_PLATFORM__ Windows ARM64\r\n'
      )

    await expect(detectRemoteHostPlatform(conn)).resolves.toMatchObject({
      relayPlatform: 'win32-arm64',
      os: 'win32',
      arch: 'arm64',
      pathFlavor: 'windows'
    })
  })

  it('ignores a marker concatenated to unterminated startup noise', async () => {
    execCommandMock.mockResolvedValueOnce(
      'startup noise__ORCA_REMOTE_PLATFORM__ Linux x86_64\n' +
        '__ORCA_REMOTE_PLATFORM__ Linux arm64\n'
    )

    await expect(detectRemoteHostPlatform(conn)).resolves.toMatchObject({
      relayPlatform: 'linux-arm64'
    })
  })

  it('returns null when neither probe yields a supported platform', async () => {
    execCommandMock
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux')
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ FreeBSD x86_64')

    await expect(detectRemoteHostPlatform(conn)).resolves.toBeNull()
  })

  it('does not use whitespace regex splitting for remote platform output', async () => {
    const splitSpy = vi.spyOn(String.prototype, 'split')
    execCommandMock.mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Darwin      arm64 extra')

    await expect(detectRemoteHostPlatform(conn)).resolves.toMatchObject({
      relayPlatform: 'darwin-arm64'
    })

    const usedWhitespaceFieldSplit = splitSpy.mock.calls.some(
      ([separator]) => separator instanceof RegExp && separator.source.includes('\\s+')
    )
    splitSpy.mockRestore()
    expect(usedWhitespaceFieldSplit).toBe(false)
  })
})
