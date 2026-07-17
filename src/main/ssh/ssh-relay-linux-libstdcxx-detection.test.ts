import { spawnSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'

const execCommandMock = vi.hoisted(() => vi.fn())

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: execCommandMock
}))

const { detectSshRelayLinuxLibstdcxx } = await import('./ssh-relay-linux-libstdcxx-detection')

const conn = {} as SshConnection
const marker = '__ORCA_SSH_RELAY_LIBSTDCXX__'

function library(path: string, ...symbols: string[]): string {
  const file = path.slice(path.lastIndexOf('/') + 1)
  return [
    `${marker} LIBRARY_BEGIN`,
    `path=${path}`,
    `file=${file}`,
    ...symbols,
    `${marker} LIBRARY_END`
  ].join('\n')
}

function segment(...libraries: string[]): string {
  return [`${marker} BEGIN`, ...libraries, `${marker} END`].join('\n')
}

describe('detectSshRelayLinuxLibstdcxx', () => {
  beforeEach(() => {
    execCommandMock.mockReset()
  })

  it.each([
    {
      label: 'Rocky 8 floor',
      output: library(
        '/usr/lib64/libstdc++.so.6.0.25',
        'GLIBCXX_3.4',
        'GLIBCXX_3.4.24',
        'GLIBCXX_3.4.25'
      ),
      expected: { libstdcxxVersion: '6.0.25', glibcxxVersion: '3.4.25' }
    },
    {
      label: 'Ubuntu 22.04',
      output: library(
        '/usr/lib/aarch64-linux-gnu/libstdc++.so.6.0.30',
        'GLIBCXX_3.4.25',
        'GLIBCXX_3.4.30',
        'GLIBCXX_3.4.29'
      ),
      expected: { libstdcxxVersion: '6.0.30', glibcxxVersion: '3.4.30' }
    },
    {
      label: 'consistent multilib candidates',
      output: [
        library('/usr/lib64/libstdc++.so.6.0.25', 'GLIBCXX_3.4.25'),
        library('/usr/lib/libstdc++.so.6.0.25', 'GLIBCXX_3.4.25')
      ].join('\n'),
      expected: { libstdcxxVersion: '6.0.25', glibcxxVersion: '3.4.25' }
    }
  ])('returns the strict maximum ABI pair for $label', async ({ output, expected }) => {
    execCommandMock.mockResolvedValueOnce(
      ['Last login: ignored', segment(output), 'post-command noise'].join('\n')
    )

    await expect(detectSshRelayLinuxLibstdcxx(conn)).resolves.toEqual(expected)
  })

  it.each([
    ['', 'empty output'],
    [segment(), 'no loader candidate or refused loader override'],
    [library('/usr/lib64/libstdc++.so.6.0.25', 'GLIBCXX_3.4.25'), 'unmarked library'],
    [
      `${marker} BEGIN\n${library('/usr/lib64/libstdc++.so.6.0.25', 'GLIBCXX_3.4.25')}`,
      'unterminated outer segment'
    ],
    [
      segment(`${marker} LIBRARY_BEGIN\npath=/usr/lib64/libstdc++.so.6.0.25`),
      'unterminated library segment'
    ],
    [segment(library('../libstdc++.so.6.0.25', 'GLIBCXX_3.4.25')), 'non-absolute path'],
    [
      segment(library(`/usr/${'a'.repeat(1025)}/libstdc++.so.6.0.25`, 'GLIBCXX_3.4.25')),
      'oversized path'
    ],
    [segment(library('/usr/lib64/libstdc++.so.6.bad', 'GLIBCXX_3.4.25')), 'malformed filename'],
    [segment(library('/usr/lib64/libstdc++.so.6.0.25')), 'missing GLIBCXX symbols'],
    [segment(library('/usr/lib64/libstdc++.so.6.0.25', 'GLIBCXX_3.4.bad')), 'malformed symbol'],
    [
      segment(
        library('/usr/lib64/libstdc++.so.6.0.25', 'GLIBCXX_3.4.25'),
        library('/usr/lib/libstdc++.so.6.0.30', 'GLIBCXX_3.4.30')
      ),
      'conflicting multilib candidates'
    ],
    [
      segment(
        library('/usr/lib64/libstdc++.so.6.0.25', 'GLIBCXX_3.4.25'),
        library('/usr/lib64/libstdc++.so.6.0.25', 'GLIBCXX_3.4.25')
      ),
      'duplicate resolved path'
    ],
    [segment(`${marker} LIBRARY_OVERFLOW`), 'candidate overflow'],
    [
      segment(
        library(
          '/usr/lib64/libstdc++.so.6.0.25',
          ...Array.from({ length: 257 }, () => 'GLIBCXX_3.4.25')
        )
      ),
      'symbol count overflow'
    ],
    [
      segment(
        library('/usr/lib64/libstdc++.so.6.0.25', 'GLIBCXX_3.4.25', `${marker} SYMBOL_OVERFLOW`)
      ),
      'explicit symbol overflow'
    ],
    [
      `startup${marker} BEGIN\n${library('/usr/lib64/libstdc++.so.6.0.25', 'GLIBCXX_3.4.25')}\n${marker} END`,
      'marker concatenated to startup noise'
    ]
  ])('returns unknown for %s', async (output) => {
    execCommandMock.mockResolvedValueOnce(output)

    await expect(detectSshRelayLinuxLibstdcxx(conn)).resolves.toBeUndefined()
  })

  it('classifies an unavailable probe as unknown without inventing composition policy', async () => {
    execCommandMock.mockRejectedValueOnce(new Error('remote command unavailable'))

    await expect(detectSshRelayLinuxLibstdcxx(conn)).resolves.toBeUndefined()
  })

  it('propagates cancellation and passes the signal into the single bounded probe', async () => {
    const signal = new AbortController().signal
    const abortError = Object.assign(new Error('cancelled'), { name: 'AbortError' })
    execCommandMock.mockRejectedValueOnce(abortError)

    await expect(detectSshRelayLinuxLibstdcxx(conn, { signal })).rejects.toBe(abortError)
    expect(execCommandMock).toHaveBeenCalledTimes(1)
    expect(execCommandMock).toHaveBeenCalledWith(conn, expect.any(String), {
      signal,
      timeoutMs: 15_000
    })
  })

  it('constructs one bounded loader-cache probe without strings or runtime dependencies', async () => {
    execCommandMock.mockResolvedValueOnce(
      segment(library('/usr/lib64/libstdc++.so.6.0.25', 'GLIBCXX_3.4.25'))
    )

    await detectSshRelayLinuxLibstdcxx(conn)

    const command = execCommandMock.mock.calls[0]?.[1] ?? ''
    expect(command).toContain('ldconfig')
    expect(command).toContain('readlink -f')
    expect(command).toContain("grep -ao 'GLIBCXX_[0-9][0-9.]*'")
    expect(command).toContain('LD_LIBRARY_PATH')
    expect(command).toContain('LD_PRELOAD')
    expect(command).toContain('256')
    expect(command).toContain('8')
    expect(command).toContain(`${marker} BEGIN`)
    expect(command).toContain(`${marker} END`)
    expect(command).not.toMatch(
      /\b(?:node|npm|python|perl|tar|sha256sum|shasum|strings|gcc|g\+\+|rpm|dpkg|apk)\b/u
    )
  })

  it.skipIf(process.platform === 'win32')('constructs valid POSIX shell syntax', async () => {
    execCommandMock.mockResolvedValueOnce(segment())

    await detectSshRelayLinuxLibstdcxx(conn)

    const command = execCommandMock.mock.calls[0]?.[1] ?? ''
    const result = spawnSync('/bin/sh', ['-n'], { input: command, encoding: 'utf8' })
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
  })
})
