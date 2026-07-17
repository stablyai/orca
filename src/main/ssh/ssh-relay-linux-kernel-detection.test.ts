import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'

const execCommandMock = vi.hoisted(() => vi.fn())

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: execCommandMock
}))

const { detectSshRelayLinuxKernelRelease } = await import('./ssh-relay-linux-kernel-detection')

const conn = {} as SshConnection
const marker = '__ORCA_SSH_RELAY_KERNEL__'

function segment(...lines: string[]): string {
  return [`${marker} BEGIN`, ...lines, `${marker} END`].join('\n')
}

describe('detectSshRelayLinuxKernelRelease', () => {
  beforeEach(() => {
    execCommandMock.mockReset()
  })

  it.each(['4.18.0-553.5.1.el8_10.x86_64', '5.15.0-107-generic', '6.6.15-0-lts'])(
    'returns the exact marked distro kernel release %s',
    async (release) => {
      execCommandMock.mockResolvedValueOnce(
        ['Last login: ignored', segment(release), 'post-command noise'].join('\n')
      )

      await expect(detectSshRelayLinuxKernelRelease(conn)).resolves.toBe(release)
    }
  )

  it.each([
    ['', 'empty segment'],
    ['6.8.0\nsecond-line', 'multiple marked lines'],
    [`${marker} BEGIN\n6.8.0`, 'unterminated segment'],
    [segment('x'.repeat(257)), 'oversized release'],
    [segment('release-6.8.0'), 'malformed numeric prefix'],
    [segment('6.8.0 generic'), 'suffix whitespace'],
    [segment('6.8.0/generic'), 'suffix slash'],
    [segment('6.8.0:generic'), 'suffix colon'],
    [segment('6.8.0@generic'), 'unsupported suffix punctuation'],
    [segment('6.8.0\tgeneric'), 'control whitespace'],
    ['6.8.0', 'unmarked evidence'],
    [[segment('6.8.0'), segment('6.8.0')].join('\n'), 'duplicate complete segments'],
    [`startup${marker} BEGIN\n6.8.0\n${marker} END`, 'marker concatenated to startup noise']
  ])('returns unknown for %s', async (output) => {
    execCommandMock.mockResolvedValueOnce(output)

    await expect(detectSshRelayLinuxKernelRelease(conn)).resolves.toBeUndefined()
  })

  it('classifies an unavailable probe as unknown without inventing fallback policy', async () => {
    execCommandMock.mockRejectedValueOnce(new Error('remote command unavailable'))

    await expect(detectSshRelayLinuxKernelRelease(conn)).resolves.toBeUndefined()
  })

  it('propagates cancellation and passes the signal into the single bounded probe', async () => {
    const signal = new AbortController().signal
    const abortError = Object.assign(new Error('cancelled'), { name: 'AbortError' })
    execCommandMock.mockRejectedValueOnce(abortError)

    await expect(detectSshRelayLinuxKernelRelease(conn, { signal })).rejects.toBe(abortError)
    expect(execCommandMock).toHaveBeenCalledTimes(1)
    expect(execCommandMock).toHaveBeenCalledWith(conn, expect.any(String), {
      signal,
      timeoutMs: 15_000
    })
  })

  it('constructs one marked POSIX-shell uname probe without runtime dependencies', async () => {
    execCommandMock.mockResolvedValueOnce(segment('6.8.0'))

    await detectSshRelayLinuxKernelRelease(conn)

    const command = execCommandMock.mock.calls[0]?.[1] ?? ''
    expect(command).toContain('command -v uname')
    expect(command).toContain('uname -r')
    expect(command.match(/uname -r/gu)).toHaveLength(1)
    expect(command).toContain(`${marker} BEGIN`)
    expect(command).toContain(`${marker} END`)
    expect(command).not.toMatch(/\b(?:node|npm|python|perl|tar|sha256sum|shasum)\b/u)
  })
})
