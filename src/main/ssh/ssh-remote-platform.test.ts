import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertSafeRemotePathSegment,
  getRemoteHostPlatform,
  joinRemotePath
} from './ssh-remote-platform'
import { detectRemoteHostPlatform } from './ssh-remote-platform-detection'
import { execCommand } from './ssh-relay-deploy-helpers'
import type { SshConnection } from './ssh-connection'

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn()
}))

const conn = {} as SshConnection

function decodePowerShellCommand(command: string): string {
  const match = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)
  return match ? Buffer.from(match[1], 'base64').toString('utf16le') : ''
}

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

describe('assertSafeRemotePathSegment', () => {
  it('accepts ordinary names under both path flavors', () => {
    expect(() => assertSafeRemotePathSegment('report copy.txt', 'posix')).not.toThrow()
    expect(() => assertSafeRemotePathSegment('report copy.txt', 'windows')).not.toThrow()
  })

  it.each(['.', '..', '../secret', 'child/name', 'nul\0byte'])(
    'rejects invalid segment %j under both path flavors',
    (segment) => {
      expect(() => assertSafeRemotePathSegment(segment, 'posix')).toThrow(
        'Unsafe remote path segment'
      )
      expect(() => assertSafeRemotePathSegment(segment, 'windows')).toThrow(
        'Unsafe remote path segment'
      )
    }
  )

  it('preserves valid POSIX names that Windows would reinterpret', () => {
    expect(() => assertSafeRemotePathSegment('notes\\2026\nfinal.txt', 'posix')).not.toThrow()
  })

  it.each([
    '..\\..\\.ssh\\orca_drop',
    'report.txt:orca',
    'question?.txt',
    'trailing.',
    'trailing ',
    'NUL',
    'con.txt',
    'CONIN$',
    'CLOCK$.log',
    'COM1.log',
    'LPT¹'
  ])('rejects Win32-special segment %j', (segment) => {
    expect(() => assertSafeRemotePathSegment(segment, 'windows')).toThrow(
      'Unsafe remote path segment'
    )
  })
})

describe('detectRemoteHostPlatform', () => {
  it('uses uname when the remote is POSIX', async () => {
    vi.mocked(execCommand).mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Darwin arm64')

    await expect(detectRemoteHostPlatform(conn)).resolves.toMatchObject({
      relayPlatform: 'darwin-arm64',
      commandDialect: 'posix'
    })
  })

  it('falls back to PowerShell when uname is unavailable on Windows', async () => {
    vi.mocked(execCommand)
      .mockRejectedValueOnce(new Error('uname not recognized'))
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Windows AMD64')

    await expect(detectRemoteHostPlatform(conn)).resolves.toMatchObject({
      relayPlatform: 'win32-x64',
      commandDialect: 'powershell',
      pathFlavor: 'windows'
    })

    expect(vi.mocked(execCommand).mock.calls[1]?.[1]).toContain('powershell.exe')
    const script = decodePowerShellCommand(vi.mocked(execCommand).mock.calls[1]?.[1] ?? '')
    expect(script).toContain('$arch = $env:PROCESSOR_ARCHITECTURE')
    expect(script).toContain('try { $runtimeArch =')
    expect(script).toContain('catch {}')
    expect(script).toContain('Write-Output ("`n__ORCA_REMOTE_PLATFORM__ Windows " + $arch)')
  })
})
