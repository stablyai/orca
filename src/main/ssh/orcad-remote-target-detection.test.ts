import { describe, expect, it } from 'vitest'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { parseRemoteLinuxLibc, remoteLinuxLibcProbeCommand } from './orcad-remote-target-detection'

describe('orcad remote target detection', () => {
  it('parses only marker-scoped libc evidence', () => {
    expect(parseRemoteLinuxLibc('login banner musl\n__ORCA_LINUX_LIBC__ glibc\n')).toBe('glibc')
    expect(parseRemoteLinuxLibc('__ORCA_LINUX_LIBC__ musl\n')).toBe('musl')
    expect(parseRemoteLinuxLibc('glibc\n')).toBeNull()
    expect(parseRemoteLinuxLibc('__ORCA_LINUX_LIBC__ unknown\n')).toBeNull()
  })

  it('emits a POSIX probe with glibc, musl, and fail-closed outcomes', () => {
    const command = remoteLinuxLibcProbeCommand()
    expect(command).toContain('getconf GNU_LIBC_VERSION')
    expect(command).toContain('ldd --version')
    expect(command).toContain('ld-musl-*.so.1')
    expect(command).toContain('__ORCA_LINUX_LIBC__')
    expect(command).toContain('unknown')
  })

  it('keeps the supported non-Linux target shapes aligned with remote platform detection', () => {
    expect(getRemoteHostPlatform('darwin-arm64')).toMatchObject({ os: 'darwin', arch: 'arm64' })
    expect(getRemoteHostPlatform('win32-x64')).toMatchObject({ os: 'win32', arch: 'x64' })
  })
})
