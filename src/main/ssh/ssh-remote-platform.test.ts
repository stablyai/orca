import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRemoteHostPlatform, joinRemotePath } from './ssh-remote-platform'
import { detectRemoteHostPlatform } from './ssh-remote-platform-detection'
import { execCommand } from './ssh-relay-deploy-helpers'
import type { SshConnection } from './ssh-connection'

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn()
}))

const conn = {} as SshConnection

beforeEach(() => {
  vi.clearAllMocks()
})

describe('joinRemotePath', () => {
  it('joins POSIX remote paths', () => {
    expect(joinRemotePath(getRemoteHostPlatform('linux-x64'), '/home/me', '.orca-remote')).toBe(
      '/home/me/.orca-remote'
    )
  })

  it('normalizes and joins Windows remote paths with forward slashes for SFTP and Node', () => {
    expect(
      joinRemotePath(getRemoteHostPlatform('win32-x64'), 'C:\\Users\\me', '.orca-remote', 'relay')
    ).toBe('C:/Users/me/.orca-remote/relay')
  })
})

describe('detectRemoteHostPlatform', () => {
  it('uses uname when the remote is POSIX', async () => {
    vi.mocked(execCommand).mockResolvedValueOnce('Darwin arm64')

    await expect(detectRemoteHostPlatform(conn)).resolves.toMatchObject({
      relayPlatform: 'darwin-arm64',
      commandDialect: 'posix'
    })
  })

  it('falls back to PowerShell when uname is unavailable on Windows', async () => {
    vi.mocked(execCommand)
      .mockRejectedValueOnce(new Error('uname not recognized'))
      .mockResolvedValueOnce('Windows AMD64')

    await expect(detectRemoteHostPlatform(conn)).resolves.toMatchObject({
      relayPlatform: 'win32-x64',
      commandDialect: 'powershell',
      pathFlavor: 'windows'
    })

    expect(vi.mocked(execCommand).mock.calls[1]?.[1]).toContain('powershell.exe')
  })
})
