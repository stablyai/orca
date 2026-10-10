import type * as FsModule from 'node:fs'
import type * as OsModule from 'node:os'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
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

const isWindows = process.platform === 'win32'

describe('loadUserSshConfig regressions', () => {
  // Windows-only: under a POSIX temp home getPathApi picks the posix branch,
  // where the backslash includes stay literal filenames and never resolve.
  it.skipIf(!isWindows)('supports Windows-style home paths and include separators', async () => {
    // Real filesystem: the per-segment walker reads through `opendirSync`, which
    // node:fs module mocks in this pool do not intercept.
    const home = mkdtempSync(join(tmpdir(), 'orca-ssh-win-sep-'))
    try {
      const confDir = join(home, '.ssh', 'conf.d')
      const quotedDir = join(home, '.ssh', 'quoted configs')
      const forwardDir = join(home, '.ssh', 'forward')
      mkdirSync(confDir, { recursive: true })
      mkdirSync(quotedDir, { recursive: true })
      mkdirSync(forwardDir, { recursive: true })
      writeFileSync(
        join(home, '.ssh', 'config'),
        'Include .\\conf.d\\*.conf "quoted configs\\team.conf" forward/slash.conf\n'
      )
      writeFileSync(join(confDir, 'zeta.conf'), 'Host zeta\n  HostName zeta.example.com\n')
      writeFileSync(join(confDir, 'alpha.conf'), 'Host alpha\n  HostName alpha.example.com\n')
      writeFileSync(join(quotedDir, 'team.conf'), 'Host team\n  HostName team.example.com\n')
      writeFileSync(
        join(forwardDir, 'slash.conf'),
        'Host forward\n  HostName forward.example.com\n'
      )

      await mockOs(home)

      const hosts = await loadUserSshConfig()
      expect(hosts.map((host) => host.host)).toEqual(['alpha', 'zeta', 'team', 'forward'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
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
    // Real filesystem: 300 matches clear the 256-result match cap but stay
    // inside the 4096-entry traversal budget, so this exercises the match cap.
    const home = mkdtempSync(join(tmpdir(), 'orca-ssh-caps-'))
    try {
      const confDir = join(home, '.ssh', 'conf.d')
      mkdirSync(confDir, { recursive: true })
      writeFileSync(join(home, '.ssh', 'config'), 'Include conf.d/*.conf\n')
      for (let index = 0; index < 300; index += 1) {
        writeFileSync(
          join(confDir, `${String(index).padStart(4, '0')}.conf`),
          `Host host-${index}\n  HostName ${index}.example.com\n`
        )
      }

      await mockOs(home)

      const hosts = await loadUserSshConfig()
      expect(hosts.length).toBe(256)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('matched'))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
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

  it('expands recursive include globs across nested directories', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const home = mkdtempSync(join(tmpdir(), 'orca-ssh-include-glob-'))
    try {
      const confDir = join(home, '.ssh', 'conf.d')
      mkdirSync(join(confDir, 'nested'), { recursive: true })
      writeFileSync(join(home, '.ssh', 'config'), 'Include ~/.ssh/conf.d/**/*.conf\n')
      writeFileSync(join(confDir, 'alpha.conf'), 'Host alpha\n  HostName alpha.example.com\n')
      writeFileSync(
        join(confDir, 'nested', 'gamma.conf'),
        'Host gamma\n  HostName gamma.example.com\n'
      )

      await mockOs(home)

      expect(await loadUserSshConfig()).toEqual([
        { host: 'alpha', hostname: 'alpha.example.com' },
        { host: 'gamma', hostname: 'gamma.example.com' }
      ])
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('warns when include brace alternatives exceed the expansion cap', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const home = mkdtempSync(join(tmpdir(), 'orca-ssh-brace-cap-'))
    try {
      mkdirSync(join(home, '.ssh', 'comb'), { recursive: true })
      writeFileSync(
        join(home, '.ssh', 'config'),
        'Include ~/.ssh/comb/{1,2,3,4,5,6,7,8,9}{1,2,3,4,5,6,7,8,9}/*.conf\n'
      )

      await mockOs(home)

      await loadUserSshConfig()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('brace expansion'))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('warns when entry-budget truncation combines with the match cap', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Real filesystem: 4100 matches exceed the 4096-entry traversal budget, so
    // the expander must surface the truncation note on top of the 256-match cap
    // instead of silently dropping the rest of the include.
    const home = mkdtempSync(join(tmpdir(), 'orca-ssh-budget-cap-'))
    try {
      const confDir = join(home, '.ssh', 'conf.d')
      mkdirSync(confDir, { recursive: true })
      writeFileSync(join(home, '.ssh', 'config'), 'Include conf.d/*.conf\n')
      for (let index = 0; index < 4100; index += 1) {
        writeFileSync(join(confDir, `${String(index).padStart(4, '0')}.conf`), `Host h-${index}\n`)
      }

      await mockOs(home)

      const hosts = await loadUserSshConfig()
      expect(hosts.length).toBe(256)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('matched'))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('traversal stopped'))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  // Bounds discovery over large trees is covered end to end by
  // ssh-config-include-glob.test.ts (4096-entry budget against a real
  // filesystem); the fs-mock variant of that scenario never worked because
  // node builtin mocks do not reach this module graph in this pool.
})
