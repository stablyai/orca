import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveRepoPathArgument } from './repo-path-arguments'
import { RuntimeClientError } from './runtime-client'

describe('resolveRepoPathArgument', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('resolves local relative paths against cwd', () => {
    expect(resolveRepoPathArgument('apps/web', '/tmp/repo', false)).toBe('/tmp/repo/apps/web')
  })

  it('keeps remote absolute POSIX paths unchanged', () => {
    expect(resolveRepoPathArgument('/home/me/orca', '/tmp/client', true)).toBe('/home/me/orca')
  })

  it('rejects remote relative paths', () => {
    expect(() =>
      resolveRepoPathArgument('./apps/web', '/tmp/client', true, 'Remote repo add')
    ).toThrow(/absolute path on the remote server/)
  })

  it('rejects Windows-desktop POSIX absolute paths that would become C:\\home\\...', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    expect(() =>
      resolveRepoPathArgument(
        '/home/minhun/dev/orca-r11-reconnect',
        'C:\\Users\\me',
        false,
        'Remote repo add'
      )
    ).toThrow(RuntimeClientError)
    try {
      resolveRepoPathArgument(
        '/home/minhun/dev/orca-r11-reconnect',
        'C:\\Users\\me',
        false,
        'Remote repo add'
      )
    } catch (error) {
      expect((error as RuntimeClientError).message).toContain('--host ssh:<connectionId>')
      expect((error as RuntimeClientError).message).toContain('not --environment')
    }
  })

  it('preserves remote absolute paths when --host routes off the desktop', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    expect(
      resolveRepoPathArgument('/home/minhun/dev/orca-r11-reconnect', 'C:\\Users\\me', true)
    ).toBe('/home/minhun/dev/orca-r11-reconnect')
  })
})
