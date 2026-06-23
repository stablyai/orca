import { describe, expect, it, vi } from 'vitest'
import { homedir } from 'os'
import { buildRelayCommandEnv } from './relay-command-env'

// homedir() is the fallback when the relay env carries no HOME; mock it so the
// fallback path is deterministic and the "no resolvable home" branch is reachable.
vi.mock('os', () => ({ homedir: vi.fn(() => '/home/fallback') }))

describe('buildRelayCommandEnv', () => {
  it('adds POSIX git locations when the relay starts with an empty PATH', () => {
    const env = buildRelayCommandEnv({ HOME: '/home/me', PATH: '' }, 'linux')

    expect(env.PATH?.split(':')).toEqual(
      expect.arrayContaining(['/usr/local/bin', '/usr/bin', '/bin'])
    )
    expect(env.HOME).toBe('/home/me')
  })

  it('preserves Windows Path casing and adds Git install locations', () => {
    const env = buildRelayCommandEnv({ Path: 'C:\\Tools' }, 'win32')

    expect(env.PATH).toBeUndefined()
    expect(env.Path?.split(';')).toEqual(
      expect.arrayContaining(['C:\\Tools', 'C:\\Program Files\\Git\\cmd'])
    )
  })

  it('adds per-user package-manager bins resolved from HOME on POSIX', () => {
    const env = buildRelayCommandEnv({ HOME: '/home/me', PATH: '/usr/bin' }, 'linux')

    expect(env.PATH?.split(':')).toEqual(
      expect.arrayContaining([
        '/home/me/.local/bin',
        '/home/me/.npm-global/bin',
        '/home/me/.cargo/bin',
        '/home/me/.bun/bin',
        '/home/me/go/bin',
        '/home/me/.deno/bin',
        '/home/me/.local/share/pnpm'
      ])
    )
  })

  it('honors a relocated npm global prefix via npm_config_prefix', () => {
    const env = buildRelayCommandEnv(
      { HOME: '/home/me', PATH: '', npm_config_prefix: '/opt/npm' },
      'linux'
    )

    expect(env.PATH?.split(':')).toContain('/opt/npm/bin')
  })

  it('honors a relocated cargo home via CARGO_HOME', () => {
    const env = buildRelayCommandEnv(
      { HOME: '/home/me', PATH: '', CARGO_HOME: '/opt/cargo' },
      'linux'
    )
    const segments = env.PATH?.split(':') ?? []

    expect(segments).toContain('/opt/cargo/bin')
    expect(segments).not.toContain('/home/me/.cargo/bin')
  })

  it('honors a relocated bun install via BUN_INSTALL', () => {
    const env = buildRelayCommandEnv(
      { HOME: '/home/me', PATH: '', BUN_INSTALL: '/opt/bun' },
      'linux'
    )
    const segments = env.PATH?.split(':') ?? []

    expect(segments).toContain('/opt/bun/bin')
    expect(segments).not.toContain('/home/me/.bun/bin')
  })

  it('honors a relocated deno install via DENO_INSTALL', () => {
    const env = buildRelayCommandEnv(
      { HOME: '/home/me', PATH: '', DENO_INSTALL: '/opt/deno' },
      'linux'
    )
    const segments = env.PATH?.split(':') ?? []

    expect(segments).toContain('/opt/deno/bin')
    expect(segments).not.toContain('/home/me/.deno/bin')
  })

  it('uses GOBIN directly for the go bin directory', () => {
    const env = buildRelayCommandEnv({ HOME: '/home/me', PATH: '', GOBIN: '/opt/go/bin' }, 'linux')
    const segments = env.PATH?.split(':') ?? []

    expect(segments).toContain('/opt/go/bin')
    expect(segments).not.toContain('/home/me/go/bin')
  })

  it('honors GOPATH for the go bin directory when GOBIN is unset', () => {
    const env = buildRelayCommandEnv({ HOME: '/home/me', PATH: '', GOPATH: '/opt/gopath' }, 'linux')
    const segments = env.PATH?.split(':') ?? []

    expect(segments).toContain('/opt/gopath/bin')
    expect(segments).not.toContain('/home/me/go/bin')
  })

  it('honors PNPM_HOME for the pnpm global bin directory', () => {
    const env = buildRelayCommandEnv(
      { HOME: '/home/me', PATH: '', PNPM_HOME: '/opt/pnpm' },
      'linux'
    )
    const segments = env.PATH?.split(':') ?? []

    expect(segments).toContain('/opt/pnpm')
    expect(segments).not.toContain('/home/me/.local/share/pnpm')
  })

  it('honors XDG_DATA_HOME for pnpm when PNPM_HOME is unset', () => {
    const env = buildRelayCommandEnv(
      { HOME: '/home/me', PATH: '', XDG_DATA_HOME: '/opt/xdg' },
      'linux'
    )
    const segments = env.PATH?.split(':') ?? []

    expect(segments).toContain('/opt/xdg/pnpm')
    expect(segments).not.toContain('/home/me/.local/share/pnpm')
  })

  it('adds the macOS pnpm home for Darwin relay envs', () => {
    const env = buildRelayCommandEnv({ HOME: '/Users/me', PATH: '' }, 'darwin')

    expect(env.PATH?.split(':')).toContain('/Users/me/Library/pnpm')
  })

  it('does not leak POSIX user bins into a Windows relay env', () => {
    const env = buildRelayCommandEnv({ Path: 'C:\\Tools', HOME: '/home/me' }, 'win32')

    expect(env.Path).not.toContain('/home/me/.local/bin')
    expect(env.Path).not.toContain('.npm-global')
  })

  it('adds Windows user package-manager bins to a Windows relay env', () => {
    const env = buildRelayCommandEnv(
      {
        Path: 'C:\\Tools',
        APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
        USERPROFILE: 'C:\\Users\\me',
        PNPM_HOME: 'C:\\Users\\me\\AppData\\Local\\pnpm-home'
      },
      'win32'
    )
    const segments = env.Path?.split(';') ?? []

    expect(segments).toEqual(
      expect.arrayContaining([
        'C:\\Users\\me\\AppData\\Roaming\\npm',
        'C:\\Users\\me\\AppData\\Local\\pnpm',
        'C:\\Users\\me\\.cargo\\bin',
        'C:\\Users\\me\\.bun\\bin',
        'C:\\Users\\me\\go\\bin',
        'C:\\Users\\me\\.deno\\bin',
        'C:\\Users\\me\\AppData\\Local\\pnpm-home'
      ])
    )
  })

  it('honors relocated Windows package-manager env vars', () => {
    const env = buildRelayCommandEnv(
      {
        Path: 'C:\\Tools',
        CARGO_HOME: 'D:\\cargo',
        BUN_INSTALL: 'D:\\bun',
        DENO_INSTALL: 'D:\\deno',
        GOBIN: 'D:\\go\\bin',
        PNPM_HOME: 'D:\\pnpm'
      },
      'win32'
    )
    const segments = env.Path?.split(';') ?? []

    expect(segments).toEqual(
      expect.arrayContaining([
        'D:\\cargo\\bin',
        'D:\\bun\\bin',
        'D:\\deno\\bin',
        'D:\\go\\bin',
        'D:\\pnpm'
      ])
    )
  })

  it('deduplicates a user bin already present in the inherited PATH', () => {
    const env = buildRelayCommandEnv({ HOME: '/home/me', PATH: '/home/me/.local/bin' }, 'linux')
    const segments = env.PATH?.split(':') ?? []

    expect(segments.filter((s) => s === '/home/me/.local/bin')).toHaveLength(1)
  })

  it('falls back to homedir() for user bins when the relay env carries no HOME', () => {
    const env = buildRelayCommandEnv({ PATH: '/usr/bin' }, 'linux')

    expect(env.PATH?.split(':')).toContain('/home/fallback/.local/bin')
    expect(env.PATH).not.toContain('undefined')
  })

  it('adds only POSIX fallbacks when no home directory can be resolved', () => {
    vi.mocked(homedir).mockReturnValueOnce('')
    const env = buildRelayCommandEnv({ PATH: '' }, 'linux')
    const segments = env.PATH?.split(':') ?? []

    expect(segments).toEqual(expect.arrayContaining(['/usr/local/bin', '/usr/bin', '/bin']))
    expect(segments.some((s) => s.includes('.local/bin'))).toBe(false)
  })

  it('keeps inherited PATH entries ahead of the appended fallbacks', () => {
    const env = buildRelayCommandEnv({ HOME: '/home/me', PATH: '/custom/bin' }, 'linux')
    const segments = env.PATH?.split(':') ?? []

    expect(segments.indexOf('/custom/bin')).toBeLessThan(segments.indexOf('/usr/bin'))
  })

  it('orders the static POSIX fallbacks ahead of the resolved user bins', () => {
    const env = buildRelayCommandEnv({ HOME: '/home/me', PATH: '' }, 'linux')
    const segments = env.PATH?.split(':') ?? []

    expect(segments.indexOf('/usr/bin')).toBeLessThan(segments.indexOf('/home/me/.local/bin'))
  })

  it('treats an empty-string HOME as absent and falls back to homedir()', () => {
    const env = buildRelayCommandEnv({ HOME: '', PATH: '/usr/bin' }, 'linux')

    expect(env.PATH?.split(':')).toContain('/home/fallback/.local/bin')
  })
})
