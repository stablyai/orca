import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'

const execCommandMock = vi.hoisted(() => vi.fn())

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: execCommandMock
}))

const { detectSshRelayDarwinVersion } = await import('./ssh-relay-darwin-version-detection')

const conn = {} as SshConnection
const marker = '__ORCA_SSH_RELAY_DARWIN_VERSION__'

function segment(...lines: string[]): string {
  return [`${marker} BEGIN`, ...lines, `${marker} END`].join('\n')
}

describe('detectSshRelayDarwinVersion', () => {
  beforeEach(() => {
    execCommandMock.mockReset()
  })

  it.each(['13.5', '10.15.7', '15.4.1', '15.4.1.2'])(
    'returns the exact marked macOS product version %s',
    async (version) => {
      execCommandMock.mockResolvedValueOnce(
        ['Last login: ignored', segment(version), 'post-command noise'].join('\n')
      )

      await expect(detectSshRelayDarwinVersion(conn)).resolves.toBe(version)
    }
  )

  it.each([
    ['', 'empty segment'],
    ['15.4\nsecond-line', 'multiple marked lines'],
    [`${marker} BEGIN\n15.4`, 'unterminated segment'],
    [segment('1'.repeat(65)), 'oversized version'],
    [segment('15'), 'missing minor component'],
    [segment('15.4.1.2.3'), 'too many components'],
    [segment('15.4-beta'), 'version suffix'],
    [segment('15.4 beta'), 'version whitespace'],
    [segment('15.4\u0000'), 'version control character'],
    [segment('15.4/beta'), 'version slash'],
    [segment('15.4:beta'), 'version colon'],
    ['15.4', 'unmarked evidence'],
    [[segment('15.4'), segment('15.4')].join('\n'), 'duplicate complete segments'],
    [`startup${marker} BEGIN\n15.4\n${marker} END`, 'marker concatenated to startup noise']
  ])('returns unknown for %s', async (output) => {
    execCommandMock.mockResolvedValueOnce(output)

    await expect(detectSshRelayDarwinVersion(conn)).resolves.toBeUndefined()
  })

  it('classifies an unavailable probe as unknown without inventing fallback policy', async () => {
    execCommandMock.mockRejectedValueOnce(new Error('remote command unavailable'))

    await expect(detectSshRelayDarwinVersion(conn)).resolves.toBeUndefined()
  })

  it('propagates cancellation and passes the signal into the single bounded probe', async () => {
    const signal = new AbortController().signal
    const abortError = Object.assign(new Error('cancelled'), { name: 'AbortError' })
    execCommandMock.mockRejectedValueOnce(abortError)

    await expect(detectSshRelayDarwinVersion(conn, { signal })).rejects.toBe(abortError)
    expect(execCommandMock).toHaveBeenCalledTimes(1)
    expect(execCommandMock).toHaveBeenCalledWith(conn, expect.any(String), {
      signal,
      timeoutMs: 15_000
    })
  })

  it('constructs one marked POSIX-shell sw_vers probe without runtime dependencies', async () => {
    execCommandMock.mockResolvedValueOnce(segment('15.4'))

    await detectSshRelayDarwinVersion(conn)

    const command = execCommandMock.mock.calls[0]?.[1] ?? ''
    expect(command).toContain('command -v sw_vers')
    expect(command).toContain('sw_vers -productVersion')
    expect(command.match(/sw_vers -productVersion/gu)).toHaveLength(1)
    expect(command).toContain(`${marker} BEGIN`)
    expect(command).toContain(`${marker} END`)
    expect(command).not.toMatch(/\b(?:node|npm|python|perl|tar|sha256sum|shasum)\b/u)
  })
})
