import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  cursorBucketForCwd,
  cursorLegacySlug,
  cursorScopeCwdCandidates,
  cursorWindowsPathVariants,
  resolveCursorLocalRoots,
  resolveCursorTargetPath
} from './session-scanner-cursor-paths'

describe('Cursor session paths', () => {
  it('resolves config and data roots with independent Cursor precedence', () => {
    expect(
      resolveCursorLocalRoots('/home/ada', {
        CURSOR_CONFIG_DIR: ' /config/cursor ',
        CURSOR_DATA_DIR: ' /data/cursor ',
        XDG_CONFIG_HOME: '/xdg'
      })
    ).toEqual({
      chatsDir: '/config/cursor/chats',
      projectsDir: '/data/cursor/projects'
    })
    expect(resolveCursorLocalRoots('/home/ada', { XDG_CONFIG_HOME: '/xdg' })).toEqual({
      chatsDir: '/xdg/cursor/chats',
      projectsDir: '/home/ada/.cursor/projects'
    })
  })

  it.each([
    ['linux' as const, '/repo/../repo/a', '/repo/a'],
    ['win32' as const, 'C:\\repo\\..\\repo\\a', 'C:\\repo\\a']
  ])('hashes the target-platform resolved path on %s', (platform, input, resolved) => {
    expect(resolveCursorTargetPath(input, platform)).toBe(resolved)
    expect(cursorBucketForCwd(input, platform)).toBe(
      createHash('md5').update(resolved).digest('hex')
    )
  })

  it('probes only exact Windows drive-letter variants', () => {
    expect(cursorWindowsPathVariants('c:\\Repo\\Mixed')).toEqual([
      'c:\\Repo\\Mixed',
      'C:\\Repo\\Mixed'
    ])
  })

  it('converts only matching-distro WSL UNC scope paths', () => {
    const scopePath = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\repo'
    expect(
      cursorScopeCwdCandidates({
        scopePath,
        platform: 'linux',
        storageContextKey: 'wsl:ubuntu'
      })
    ).toEqual(['/home/ada/repo'])
    expect(
      cursorScopeCwdCandidates({
        scopePath,
        platform: 'linux',
        storageContextKey: 'wsl:debian'
      })
    ).toEqual([])
    expect(
      cursorScopeCwdCandidates({
        scopePath,
        platform: 'win32',
        storageContextKey: 'native'
      })
    ).toEqual([])
  })

  it('uses Cursor’s untruncated lossy transcript slug', () => {
    const value = `/repo/${'long segment '.repeat(30)}`
    const slug = cursorLegacySlug(value)
    expect(slug).toBe(
      value
        .replace(/[^a-zA-Z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
    )
    expect(slug.length).toBeGreaterThan(92)
  })
})
