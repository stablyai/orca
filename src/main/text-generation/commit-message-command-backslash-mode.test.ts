/** #11375: choose rules from the execution host; a Windows client can still run a POSIX command remotely. */
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
    expect(commandBackslashMode(REMOTE, 'win32')).toBe('escape')
  })

  it('defaults to this process platform when none is given', () => {
    const expected = process.platform === 'win32' ? 'literal' : 'escape'
    expect(commandBackslashMode(LOCAL)).toBe(expected)
  })
})
