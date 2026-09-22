/**
 * The decision that turns on literal-backslash parsing (#11375).
 *
 * Why its own suite: this is the only place that reads the platform, so it is
 * where the fix can be wrong in the direction that matters — applying Windows
 * rules to a command that will actually run under a POSIX shell.
 */
import { describe, expect, it } from 'vitest'
import { commandBackslashMode } from './commit-message-text-generation'

const LOCAL = { kind: 'local' as const, cwd: 'C:\\repo' }
const REMOTE = {
  kind: 'remote' as const,
  cwd: '/repo',
  execute: async () => ({ ok: true }) as never,
  missingBinaryLocation: 'the remote host'
}

describe('commandBackslashMode', () => {
  it('reads backslashes literally only for a native Windows local target', () => {
    expect(commandBackslashMode(LOCAL, 'win32')).toBe('literal')
  })

  it.each<NodeJS.Platform>(['darwin', 'linux'])('keeps POSIX escaping on %s', (platform) => {
    expect(commandBackslashMode(LOCAL, platform)).toBe('escape')
  })

  it('keeps POSIX escaping for a WSL target, which runs a Linux binary', () => {
    expect(commandBackslashMode({ ...LOCAL, wslDistro: 'Ubuntu' }, 'win32')).toBe('escape')
  })

  it('keeps POSIX escaping for a remote target, whose platform we cannot see', () => {
    // A Windows client driving a Linux host is the case this protects.
    expect(commandBackslashMode(REMOTE, 'win32')).toBe('escape')
  })

  it('defaults to this process platform when none is given', () => {
    const expected = process.platform === 'win32' ? 'literal' : 'escape'
    expect(commandBackslashMode(LOCAL)).toBe(expected)
  })
})
