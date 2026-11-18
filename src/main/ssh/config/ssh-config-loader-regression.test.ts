import type * as FsModule from 'node:fs'
import type * as OsModule from 'node:os'
import { win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
  vi.doUnmock('fs')
  vi.doUnmock('os')
})

function normalizeWin(value: string): string {
  return win32.normalize(value.replaceAll('/', '\\'))
}

function platformSshHome(): string {
  return process.platform === 'win32' ? 'C:\\Users\\testuser' : '/home/testuser'
}

function platformSshPath(home: string, relativePath: string): string {
  return process.platform === 'win32'
    ? normalizeWin(`${home}/${relativePath}`)
    : `${home}/${relativePath}`
}

async function mockOs(
  home: string,
  username = 'testuser',
  uid = 1001,
  hostname = 'host.example.com'
) {
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof OsModule>('os')
    return {
      ...actual,
      homedir: () => home,
      hostname: () => hostname,
      userInfo: () => ({ username, uid })
    }
  })
}

async function loadUserSshConfig() {
  const mod = await import('./ssh-config-parser')
  return mod.loadUserSshConfig()
}

describe('loadUserSshConfig regressions', () => {
  it('supports Windows-style home paths and include separators', async () => {
    const files = new Map<string, string>([
      [
        normalizeWin('C:/Users/Test User/.ssh/config'),
        'Include .\\conf.d\\*.conf "C:\\Users\\Test User\\quoted configs\\team.conf" forward/slash.conf'
      ],
      [
        normalizeWin('C:/Users/Test User/.ssh/conf.d/zeta.conf'),
        'Host zeta\n  HostName zeta.example.com\n'
      ],
      [
        normalizeWin('C:/Users/Test User/.ssh/conf.d/alpha.conf'),
        'Host alpha\n  HostName alpha.example.com\n'
      ],
      [
        normalizeWin('C:/Users/Test User/quoted configs/team.conf'),
        'Host team\n  HostName team.example.com\n'
      ],
      [
        normalizeWin('C:/Users/Test User/.ssh/forward/slash.conf'),
        'Host forward\n  HostName forward.example.com\n'
      ]
    ])

    await mockOs('C:\\Users\\Test User', 'TestUser', -1, 'winbox.example.com')
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof FsModule>('fs')
      return {
        ...actual,
        existsSync: (filePath: string) => files.has(normalizeWin(filePath)),
        globSync: (pattern: string) =>
          normalizeWin(pattern) === normalizeWin('C:/Users/Test User/.ssh/conf.d/*.conf')
            ? [
                normalizeWin('C:/Users/Test User/.ssh/conf.d/alpha.conf'),
                normalizeWin('C:/Users/Test User/.ssh/conf.d/zeta.conf')
              ]
            : [],
        readFileSync: (filePath: string) => {
          const content = files.get(normalizeWin(filePath))
          if (content === undefined) {
            throw new Error(`ENOENT: ${filePath}`)
          }
          return content
        },
        realpathSync: Object.assign((filePath: string) => normalizeWin(filePath), {
          native: (filePath: string) => normalizeWin(filePath)
        }),
        statSync: (filePath: string) => {
          const content = files.get(normalizeWin(filePath))
          if (content === undefined) {
            throw new Error(`ENOENT: ${filePath}`)
          }
          return { isFile: () => true, size: content.length }
        }
      }
    })

    const hosts = await loadUserSshConfig()
    expect(hosts.map((host) => host.host)).toEqual(['alpha', 'zeta', 'team', 'forward'])
  })

  it('skips non-regular include targets without reading them', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const home = platformSshHome()
    const configPath = platformSshPath(home, '.ssh/config')
    const unsafePath = platformSshPath(home, '.ssh/unsafe.conf')
    const safePath = platformSshPath(home, '.ssh/safe.conf')
    const unsafeReadSpy = vi.fn()

    await mockOs(home)
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof FsModule>('fs')
      return {
        ...actual,
        existsSync: (filePath: string) =>
          filePath === configPath || filePath === unsafePath || filePath === safePath,
        readFileSync: (filePath: string) => {
          if (filePath === unsafePath) {
            unsafeReadSpy()
            throw new Error(`unexpected read: ${filePath}`)
          }
          if (filePath === configPath) {
            return 'Include unsafe.conf safe.conf\n'
          }
          if (filePath === safePath) {
            return 'Host safe\n  HostName safe.example.com\n'
          }
          throw new Error(`ENOENT: ${filePath}`)
        },
        realpathSync: Object.assign((filePath: string) => filePath, {
          native: (filePath: string) => filePath
        }),
        statSync: (filePath: string) => ({ isFile: () => filePath !== unsafePath, size: 64 })
      }
    })

    expect(await loadUserSshConfig()).toEqual([{ host: 'safe', hostname: 'safe.example.com' }])
    expect(unsafeReadSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping SSH config include'))
  })
})
