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

  it('preserves quoted Windows include paths with native backslashes and spaces', async () => {
    const files = new Map<string, string>([
      [
        normalizeWin('C:/Users/Test User/.ssh/config'),
        'Include "C:\\Users\\Test User\\quoted configs\\team.conf"'
      ],
      [
        normalizeWin('C:/Users/Test User/quoted configs/team.conf'),
        'Host team\n  HostName team.example.com\n'
      ]
    ])

    await mockOs('C:\\Users\\Test User', 'TestUser', -1, 'winbox.example.com')
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof FsModule>('fs')
      return {
        ...actual,
        existsSync: (filePath: string) => files.has(normalizeWin(filePath)),
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

    expect(await loadUserSshConfig()).toEqual([{ host: 'team', hostname: 'team.example.com' }])
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

  it('caps overly broad include globs and skips the remainder', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const home = platformSshHome()
    const configPath = platformSshPath(home, '.ssh/config')
    const includePaths = Array.from({ length: 2000 }, (_, index) => {
      return platformSshPath(home, `.ssh/conf.d/${String(index).padStart(4, '0')}.conf`)
    })
    const readPaths = new Set<string>()

    await mockOs(home)
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof FsModule>('fs')
      return {
        ...actual,
        existsSync: (filePath: string) =>
          filePath === configPath || includePaths.includes(filePath),
        globSync: () => [...includePaths].reverse(),
        readFileSync: (filePath: string) => {
          if (filePath === configPath) {
            return 'Include conf.d/*.conf\n'
          }
          if (includePaths.includes(filePath)) {
            readPaths.add(filePath)
            const alias = filePath.match(/(\d+)\.conf$/)?.[1] ?? 'unknown'
            return `Host host-${alias}\n  HostName ${alias}.example.com\n`
          }
          throw new Error(`ENOENT: ${filePath}`)
        },
        realpathSync: Object.assign((filePath: string) => filePath, {
          native: (filePath: string) => filePath
        }),
        statSync: (filePath: string) => ({
          isFile: () => filePath === configPath || includePaths.includes(filePath),
          size: 64
        })
      }
    })

    const hosts = await loadUserSshConfig()
    expect(hosts.length).toBeGreaterThan(0)
    expect(hosts.length).toBeLessThan(includePaths.length)
    expect(readPaths.has(includePaths.at(-1)!)).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('matched'))
  })

  it('skips oversized include files without reading them', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const home = platformSshHome()
    const configPath = platformSshPath(home, '.ssh/config')
    const oversizedPath = platformSshPath(home, '.ssh/oversized.conf')
    const safePath = platformSshPath(home, '.ssh/safe.conf')
    const oversizedReadSpy = vi.fn()

    await mockOs(home)
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof FsModule>('fs')
      return {
        ...actual,
        existsSync: (filePath: string) =>
          filePath === configPath || filePath === oversizedPath || filePath === safePath,
        readFileSync: (filePath: string) => {
          if (filePath === oversizedPath) {
            oversizedReadSpy()
            throw new Error(`unexpected read: ${filePath}`)
          }
          if (filePath === configPath) {
            return 'Include oversized.conf safe.conf\n'
          }
          if (filePath === safePath) {
            return 'Host safe\n  HostName safe.example.com\n'
          }
          throw new Error(`ENOENT: ${filePath}`)
        },
        realpathSync: Object.assign((filePath: string) => filePath, {
          native: (filePath: string) => filePath
        }),
        statSync: (filePath: string) => ({
          isFile: () => true,
          size: filePath === oversizedPath ? 2 * 1024 * 1024 : 64
        })
      }
    })

    expect(await loadUserSshConfig()).toEqual([{ host: 'safe', hostname: 'safe.example.com' }])
    expect(oversizedReadSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('exceeds'))
  })
})
