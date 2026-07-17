import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'

const execCommandMock = vi.hoisted(() => vi.fn())

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: execCommandMock
}))

const { detectSshRelayLinuxLibc } = await import('./ssh-relay-libc-detection')

const conn = {} as SshConnection
const marker = '__ORCA_SSH_RELAY_LIBC__'

function segment(source: 'getconf' | 'ldd' | 'loader', ...lines: string[]): string {
  return [`${marker} BEGIN ${source}`, ...lines, `${marker} END ${source}`].join('\n')
}

describe('detectSshRelayLinuxLibc', () => {
  beforeEach(() => {
    execCommandMock.mockReset()
  })

  it('prefers exact marked getconf evidence and ignores unmarked startup text', async () => {
    execCommandMock.mockResolvedValueOnce(
      ['musl libc (x86_64)', 'Version 9.9.9', segment('getconf', 'glibc 2.28'), 'glibc 99.0'].join(
        '\n'
      )
    )

    await expect(detectSshRelayLinuxLibc(conn)).resolves.toEqual({
      family: 'glibc',
      version: '2.28'
    })
  })

  it('accepts exact glibc evidence from a complete marked ldd fallback', async () => {
    execCommandMock.mockResolvedValueOnce(
      segment('ldd', 'ldd (GNU libc) 2.39', 'Copyright (C) Free Software Foundation')
    )

    await expect(detectSshRelayLinuxLibc(conn)).resolves.toEqual({
      family: 'glibc',
      version: '2.39'
    })
  })

  it('accepts exact musl evidence from a complete marked ldd fallback', async () => {
    execCommandMock.mockResolvedValueOnce(
      segment('ldd', 'musl libc (x86_64)', 'Version 1.2.5', 'Dynamic Program Loader')
    )

    await expect(detectSshRelayLinuxLibc(conn)).resolves.toEqual({
      family: 'musl',
      version: '1.2.5'
    })
  })

  it('accepts musl evidence from the first complete known-loader segment', async () => {
    execCommandMock.mockResolvedValueOnce(
      segment('loader', 'musl libc (aarch64)', 'Version 1.2.4', 'Dynamic Program Loader')
    )

    await expect(detectSshRelayLinuxLibc(conn)).resolves.toEqual({
      family: 'musl',
      version: '1.2.4'
    })
  })

  it('returns unknown for conflicting recognized marked candidates', async () => {
    execCommandMock.mockResolvedValueOnce(
      [segment('getconf', 'glibc 2.28'), segment('ldd', 'musl libc', 'Version 1.2.5')].join('\n')
    )

    await expect(detectSshRelayLinuxLibc(conn)).resolves.toEqual({ family: 'unknown' })
  })

  it.each([
    [`${marker} BEGIN getconf\nglibc 2.28`, 'unterminated segment'],
    [segment('getconf', 'glibc 2'), 'malformed version'],
    [
      [segment('getconf', 'glibc 2.28'), segment('getconf', 'glibc 2.28')].join('\n'),
      'duplicate source segment'
    ],
    [
      `startup noise${marker} BEGIN getconf\nglibc 2.28\n${marker} END getconf`,
      'marker concatenated to startup noise'
    ],
    [segment('getconf', 'x'.repeat(4097)), 'oversized marked line'],
    [segment('ldd', ...Array.from({ length: 9 }, () => 'noise')), 'oversized marked segment'],
    ['glibc 2.28\nldd (GNU libc) 2.28', 'unmarked evidence']
  ])('returns unknown for %s', async (output) => {
    execCommandMock.mockResolvedValueOnce(output)

    await expect(detectSshRelayLinuxLibc(conn)).resolves.toEqual({ family: 'unknown' })
  })

  it('classifies an unavailable probe as unknown without inventing fallback policy', async () => {
    execCommandMock.mockRejectedValueOnce(new Error('remote command unavailable'))

    await expect(detectSshRelayLinuxLibc(conn)).resolves.toEqual({ family: 'unknown' })
  })

  it('propagates cancellation and passes the signal into the single bounded probe', async () => {
    const signal = new AbortController().signal
    const abortError = Object.assign(new Error('cancelled'), { name: 'AbortError' })
    execCommandMock.mockRejectedValueOnce(abortError)

    await expect(detectSshRelayLinuxLibc(conn, { signal })).rejects.toBe(abortError)
    expect(execCommandMock).toHaveBeenCalledTimes(1)
    expect(execCommandMock).toHaveBeenCalledWith(conn, expect.any(String), {
      signal,
      timeoutMs: 15_000
    })
  })

  it('constructs a POSIX-shell no-Node probe with marked preferred and fallback sources', async () => {
    execCommandMock.mockResolvedValueOnce(segment('getconf', 'glibc 2.28'))

    await detectSshRelayLinuxLibc(conn)

    const command = execCommandMock.mock.calls[0]?.[1] ?? ''
    expect(command).toContain('getconf GNU_LIBC_VERSION')
    expect(command).toContain('ldd --version')
    expect(command).toContain('/lib/ld-musl-*.so.1')
    expect(command).toContain('/usr/lib/*/ld-musl-*.so.1')
    expect(command.indexOf('getconf GNU_LIBC_VERSION')).toBeLessThan(
      command.indexOf('ldd --version')
    )
    expect(command).not.toMatch(/\b(?:node|npm|python|perl|tar|sha256sum|shasum)\b/u)
  })
})
