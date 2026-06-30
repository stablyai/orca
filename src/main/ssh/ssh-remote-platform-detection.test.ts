import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'

const execCommandMock = vi.hoisted(() => vi.fn())

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: execCommandMock
}))

const { detectRemoteHostPlatform } = await import('./ssh-remote-platform-detection')

const conn = {} as SshConnection

describe('detectRemoteHostPlatform', () => {
  beforeEach(() => {
    execCommandMock.mockReset()
  })

  it('detects POSIX hosts from uname output', async () => {
    execCommandMock.mockResolvedValueOnce('Linux   x86_64\n')

    await expect(detectRemoteHostPlatform(conn)).resolves.toMatchObject({
      relayPlatform: 'linux-x64',
      os: 'linux',
      arch: 'x64',
      pathFlavor: 'posix'
    })
    expect(execCommandMock).toHaveBeenCalledWith(conn, 'uname -sm')
  })

  it('falls back to PowerShell detection for Windows remotes', async () => {
    execCommandMock
      .mockRejectedValueOnce(new Error('uname unavailable'))
      .mockResolvedValueOnce('Windows AMD64\r\n')

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
  })

  it('returns null when neither probe yields a supported platform', async () => {
    execCommandMock.mockResolvedValueOnce('Linux').mockResolvedValueOnce('FreeBSD x86_64')

    await expect(detectRemoteHostPlatform(conn)).resolves.toBeNull()
  })

  it('does not use whitespace regex splitting for remote platform output', async () => {
    const splitSpy = vi.spyOn(String.prototype, 'split')
    execCommandMock.mockResolvedValueOnce('Darwin      arm64 extra')

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
