import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'

const execCommandMock = vi.hoisted(() => vi.fn())

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: execCommandMock
}))

const { detectSshRelayDarwinProcessTranslation } =
  await import('./ssh-relay-darwin-translation-detection')

const conn = {} as SshConnection
const marker = '__ORCA_SSH_RELAY_DARWIN_TRANSLATION__'

function segment(line: string): string {
  return [`${marker} BEGIN`, line, `${marker} END`].join('\n')
}

describe('detectSshRelayDarwinProcessTranslation', () => {
  beforeEach(() => {
    execCommandMock.mockReset()
  })

  it.each([
    { line: 'translated=1 arm64=1', expected: true, label: 'translated Apple Silicon' },
    { line: 'translated=1 arm64=', expected: true, label: 'authoritative translated signal' },
    { line: 'translated=0 arm64=1', expected: false, label: 'native Apple Silicon' },
    { line: 'translated=0 arm64=0', expected: false, label: 'explicit native Intel' },
    { line: 'translated=0 arm64=', expected: false, label: 'authoritative native signal' },
    { line: 'translated= arm64=0', expected: false, label: 'Intel without the translation key' }
  ])('returns $expected for $label', async ({ line, expected }) => {
    execCommandMock.mockResolvedValueOnce(
      ['Last login: ignored', segment(line), 'post-command noise'].join('\n')
    )

    await expect(detectSshRelayDarwinProcessTranslation(conn)).resolves.toBe(expected)
  })

  it.each([
    ['', 'empty output'],
    [segment('translated= arm64=1'), 'missing translation on arm64 hardware'],
    [segment('translated= arm64='), 'missing both values'],
    [segment('translated=1 arm64=0'), 'conflicting translated Intel evidence'],
    [segment('translated=2 arm64=1'), 'invalid translation value'],
    [segment('translated=1 arm64=2'), 'invalid hardware value'],
    [segment('translated=1 arm64=1 extra=1'), 'extra field'],
    [segment('translated=1  arm64=1'), 'non-canonical whitespace'],
    [segment('translated=1\narm64=1'), 'multiple marked lines'],
    [`${marker} BEGIN\ntranslated=1 arm64=1`, 'unterminated segment'],
    [segment(`translated=${'1'.repeat(65)} arm64=1`), 'oversized value'],
    [[segment('translated=1 arm64=1'), segment('translated=1 arm64=1')].join('\n'), 'duplicate'],
    [
      `startup${marker} BEGIN\ntranslated=1 arm64=1\n${marker} END`,
      'marker concatenated to startup noise'
    ],
    ['translated=1 arm64=1', 'unmarked evidence']
  ])('returns unknown for %s', async (output) => {
    execCommandMock.mockResolvedValueOnce(output)

    await expect(detectSshRelayDarwinProcessTranslation(conn)).resolves.toBeUndefined()
  })

  it('classifies an unavailable probe as unknown without inventing composition policy', async () => {
    execCommandMock.mockRejectedValueOnce(new Error('remote command unavailable'))

    await expect(detectSshRelayDarwinProcessTranslation(conn)).resolves.toBeUndefined()
  })

  it('propagates cancellation and passes the signal into the single bounded probe', async () => {
    const signal = new AbortController().signal
    const abortError = Object.assign(new Error('cancelled'), { name: 'AbortError' })
    execCommandMock.mockRejectedValueOnce(abortError)

    await expect(detectSshRelayDarwinProcessTranslation(conn, { signal })).rejects.toBe(abortError)
    expect(execCommandMock).toHaveBeenCalledTimes(1)
    expect(execCommandMock).toHaveBeenCalledWith(conn, expect.any(String), {
      signal,
      timeoutMs: 15_000
    })
  })

  it('constructs one marked POSIX-shell sysctl probe without runtime dependencies', async () => {
    execCommandMock.mockResolvedValueOnce(segment('translated=0 arm64=1'))

    await detectSshRelayDarwinProcessTranslation(conn)

    const command = execCommandMock.mock.calls[0]?.[1] ?? ''
    expect(command).toContain('command -v sysctl')
    expect(command).toContain('sysctl -in sysctl.proc_translated')
    expect(command).toContain('sysctl -in hw.optional.arm64')
    expect(command).toContain(`${marker} BEGIN`)
    expect(command).toContain(`${marker} END`)
    expect(command).not.toMatch(/\b(?:node|npm|python|perl|tar|sha256sum|shasum)\b/u)
  })
})
