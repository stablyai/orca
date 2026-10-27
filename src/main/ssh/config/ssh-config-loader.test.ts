import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as OsModule from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadUserSshConfig } from './ssh-config-parser'

const { homedirMock, hostnameMock, userInfoMock } = vi.hoisted(() => ({
  homedirMock: vi.fn(() => '/home/testuser'),
  hostnameMock: vi.fn(() => 'workstation.example.com'),
  userInfoMock: vi.fn(() => ({ username: 'testuser', uid: 1001 }))
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof OsModule>('os')
  return {
    ...actual,
    homedir: homedirMock,
    hostname: hostnameMock,
    userInfo: userInfoMock
  }
})

const originalEnv = { ...process.env }
const tempDirs: string[] = []
const LARGE_INCLUDE_LINE_COUNT = 150_000

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key]
    }
  }
  Object.assign(process.env, originalEnv)
  homedirMock.mockImplementation(() => '/home/testuser')
  hostnameMock.mockImplementation(() => 'workstation.example.com')
  userInfoMock.mockImplementation(() => ({ username: 'testuser', uid: 1001 }))

  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeHome(prefix = 'orca-ssh-config-'): string {
  const home = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(home)
  homedirMock.mockReturnValue(home)
  mkdirSync(join(home, '.ssh'), { recursive: true })
  return home
}

function writeFile(root: string, relativePath: string, content: string): string {
  const fullPath = join(root, relativePath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content, 'utf-8')
  return fullPath
}

describe('loadUserSshConfig', () => {
  it('loads hosts from a single included file', () => {
    const home = makeHome()
    writeFile(home, '.ssh/config', 'Include included.conf\n')
    writeFile(
      home,
      '.ssh/included.conf',
      'Host included\n  HostName included.example.com\n  User deploy\n'
    )

    expect(loadUserSshConfig()).toEqual([
      {
        host: 'included',
        hostname: 'included.example.com',
        user: 'deploy'
      }
    ])
  })

  it('supports OrbStack includes, Include= syntax, quoted paths, and multiple pathnames', () => {
    const home = makeHome()
    writeFile(
      home,
      '.ssh/config',
      [
        'Include ~/.orbstack/ssh/config',
        'Include=extras/dev.conf "quoted configs/team ssh.conf"'
      ].join('\n')
    )
    writeFile(home, '.orbstack/ssh/config', 'Host orb\n  HostName 100.100.100.1\n')
    writeFile(home, '.ssh/extras/dev.conf', 'Host dev\n  HostName dev.example.com\n')
    writeFile(home, '.ssh/quoted configs/team ssh.conf', 'Host team\n  HostName team.example.com\n')

    expect(loadUserSshConfig().map((host) => host.host)).toEqual(['orb', 'dev', 'team'])
  })

  it('expands glob includes in lexical order', () => {
    const home = makeHome()
    writeFile(home, '.ssh/config', 'Include conf.d/*.conf\n')
    writeFile(home, '.ssh/conf.d/20-second.conf', 'Host second\n  HostName second.example.com\n')
    writeFile(home, '.ssh/conf.d/10-first.conf', 'Host first\n  HostName first.example.com\n')

    expect(loadUserSshConfig().map((host) => host.host)).toEqual(['first', 'second'])
  })

  it('supports relative includes, ${VAR}, and local % tokens', () => {
    const home = makeHome()
    process.env.ORCA_SSH_INCLUDE = 'from-env.conf'
    writeFile(
      home,
      '.ssh/config',
      [
        'Include relative.conf ${ORCA_SSH_INCLUDE}',
        'Include %d/.ssh/from-home.conf',
        'Include %u/%i.conf',
        'Include %%literal.conf'
      ].join('\n')
    )
    writeFile(home, '.ssh/relative.conf', 'Host relative\n  HostName relative.example.com\n')
    writeFile(home, '.ssh/from-env.conf', 'Host env\n  HostName env.example.com\n')
    writeFile(home, '.ssh/from-home.conf', 'Host from-home\n  HostName home.example.com\n')
    writeFile(home, '.ssh/testuser/1001.conf', 'Host by-user-id\n  HostName token.example.com\n')
    writeFile(home, '.ssh/%literal.conf', 'Host literal\n  HostName literal.example.com\n')

    expect(loadUserSshConfig().map((host) => host.host)).toEqual([
      'relative',
      'env',
      'from-home',
      'by-user-id',
      'literal'
    ])
  })

  it('expands Include directives inside Host and Match blocks', () => {
    const home = makeHome()
    writeFile(
      home,
      '.ssh/config',
      [
        'Host base',
        '  HostName base.example.com',
        '  Include nested/inside-host.conf',
        'Match host *.internal',
        '  Include nested/inside-match.conf',
        'Host after',
        '  HostName after.example.com'
      ].join('\n')
    )
    writeFile(home, '.ssh/nested/inside-host.conf', 'Host inner\n  HostName inner.example.com\n')
    writeFile(
      home,
      '.ssh/nested/inside-match.conf',
      'Host matched\n  HostName matched.example.com\n'
    )

    expect(loadUserSshConfig().map((host) => host.host)).toEqual([
      'base',
      'inner',
      'matched',
      'after'
    ])
  })

  it('continues parsing after a large included file', () => {
    const home = makeHome()
    writeFile(
      home,
      '.ssh/config',
      ['Include large.conf', 'Host after', '  HostName after.example.com'].join('\n')
    )
    writeFile(home, '.ssh/large.conf', '\n'.repeat(LARGE_INCLUDE_LINE_COUNT))

    expect(loadUserSshConfig()).toEqual([
      {
        host: 'after',
        hostname: 'after.example.com'
      }
    ])
  })

  it('ignores unset env includes and target-dependent tokens', () => {
    const home = makeHome()
    writeFile(
      home,
      '.ssh/config',
      ['Include ${MISSING_INCLUDE}', 'Include %h/skipped.conf', 'Include valid.conf'].join('\n')
    )
    writeFile(home, '.ssh/valid.conf', 'Host valid\n  HostName valid.example.com\n')

    expect(loadUserSshConfig().map((host) => host.host)).toEqual(['valid'])
  })

  it('terminates recursive includes and re-evaluates repeated includes', () => {
    const home = makeHome()
    writeFile(home, '.ssh/config', 'Include shared.conf shared.conf recursive.conf\n')
    writeFile(home, '.ssh/shared.conf', 'Host shared\n  HostName shared.example.com\n')
    writeFile(
      home,
      '.ssh/recursive.conf',
      'Include nested.conf\nHost recursive\n  HostName recursive.example.com\n'
    )
    writeFile(
      home,
      '.ssh/nested.conf',
      'Include recursive.conf\nHost nested\n  HostName nested.example.com\n'
    )

    expect(loadUserSshConfig().map((host) => host.host)).toEqual([
      'shared',
      'shared',
      'nested',
      'recursive'
    ])
  })

  it('returns an empty array when the user config does not exist', () => {
    makeHome()
    expect(loadUserSshConfig()).toEqual([])
  })
})
