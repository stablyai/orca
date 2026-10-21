import { describe, expect, it, vi } from 'vitest'
import { parseGlibcVersion, parseLinuxLibc, probeLinuxLibc } from './linux-libc-probe'

describe('Linux library evidence', () => {
  it.each([
    ['ldd (Ubuntu GLIBC 2.31-0ubuntu9.16) 2.31\nCopyright (C) 2020', 31],
    ['ldd (GNU libc) 2.17', 17],
    ['glibc 2.28', 28],
    ['ld.so (GNU libc) stable release version 2.36.', 36],
    ['GNU C Library (GNU libc) stable release version 2.26.', 26],
    ['GNU C Library (GNU libc) stable release version 2.26, by Roland McGrath et al.', 26],
    ['GNU C Library (Debian GLIBC 2.31-13) stable release version 2.31.', 31],
    ['Welcome to appliance 7.4\r\nldd (GNU libc) 2.31\r\n', 31]
  ])('reads glibc and its version from %j', (output, minor) => {
    expect(parseLinuxLibc(output)).toBe('glibc')
    expect(parseGlibcVersion(output)).toEqual({ major: 2, minor })
  })

  it.each(['musl libc', 'musl libc (x86_64)\nVersion 1.2.5'])('recognizes %j', (output) => {
    expect(parseLinuxLibc(output)).toBe('musl')
    expect(parseGlibcVersion(output)).toBeNull()
  })

  it.each([
    '',
    'ldd: command not found',
    'Linux x86_64',
    '/lib/ld-musl-x86_64.so.1: not found',
    'error: glibc 2.31 not found',
    'warning: musl compatibility package not installed'
  ])('refuses error messages and unproven targets: %j', (output) => {
    expect(() => parseLinuxLibc(output)).toThrow('Could not identify')
    expect(parseGlibcVersion(output)).toBeNull()
  })

  it('does not mistake an unrelated version for the glibc version', () => {
    const output = 'ldd (GNU libc) unknown\nAppliance release 7.4'
    expect(parseLinuxLibc(output)).toBe('glibc')
    expect(parseGlibcVersion(output)).toBeNull()
  })
})

describe('Linux library probe fallbacks', () => {
  it('tries the executable library when the loader does not support --version', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce('ldd: not found')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(
        'GNU C Library (GNU libc) stable release version 2.26, by Roland McGrath et al.'
      )
    await expect(probeLinuxLibc(exec)).resolves.toEqual({
      libc: 'glibc',
      glibc: { major: 2, minor: 26 }
    })
    expect(exec).toHaveBeenCalledTimes(4)
    expect(exec).toHaveBeenLastCalledWith(expect.stringContaining('/lib/libc.so.6'))
  })

  it('requires the musl loader banner instead of treating its filename as proof', async () => {
    const exec = vi
      .fn()
      .mockResolvedValue('')
      .mockResolvedValueOnce('/lib/ld-musl-x86_64.so.1: not found')
    await expect(probeLinuxLibc(exec)).rejects.toThrow('Could not identify')
    expect(exec).toHaveBeenLastCalledWith(expect.stringContaining('"$loader" 2>&1'))
  })

  it('does not select an installed musl toolchain before checking the GNU loader', async () => {
    const exec = vi
      .fn()
      .mockResolvedValue('musl libc (x86_64)\nVersion 1.2.5')
      .mockResolvedValueOnce('ldd: not found')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('ld.so (GNU libc) stable release version 2.36.')
    await expect(probeLinuxLibc(exec)).resolves.toEqual({
      libc: 'glibc',
      glibc: { major: 2, minor: 36 }
    })
    expect(exec).toHaveBeenCalledTimes(3)
  })

  it('uses a musl loader banner when tools and GNU libraries are unavailable', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce('BusyBox ldd: unrecognized option')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(
        'musl libc (aarch64)\nVersion 1.2.5\nUsage: loader [options] [--] pathname'
      )
    await expect(probeLinuxLibc(exec)).resolves.toEqual({ libc: 'musl', glibc: null })
  })

  it('stops immediately on execution or transport errors', async () => {
    const exec = vi.fn().mockResolvedValueOnce('').mockRejectedValueOnce(new Error('disconnected'))
    await expect(probeLinuxLibc(exec)).rejects.toThrow('disconnected')
    expect(exec).toHaveBeenCalledTimes(2)
  })
})
