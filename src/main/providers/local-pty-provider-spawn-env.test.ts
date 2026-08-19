import { beforeEach, describe, expect, it, vi } from 'vitest'
import { delimiter } from 'node:path'
import type * as MacosTccLoginShell from './macos-tcc-login-shell'
import { stripLegacyTerminalShimEnv } from '../pty/legacy-terminal-shim-dir'

const {
  existsSyncMock,
  statSyncMock,
  accessSyncMock,
  mkdirSyncMock,
  writeFileSyncMock,
  spawnMock,
  prepareMacosTccLoginShellMock,
  resolveAgentForegroundProcessMock,
  readWindowsConptyProcessIdsMock,
  killWithDescendantSweepMock,
  isWslAvailableAsyncMock,
  wslUncDirectoryExistsMock,
  createShellPromptReadinessProbeMock
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  accessSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  prepareMacosTccLoginShellMock: vi.fn(),
  resolveAgentForegroundProcessMock: vi.fn(),
  readWindowsConptyProcessIdsMock: vi.fn(),
  killWithDescendantSweepMock: vi.fn(),
  isWslAvailableAsyncMock: vi.fn(),
  wslUncDirectoryExistsMock: vi.fn(),
  createShellPromptReadinessProbeMock: vi.fn()
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  statSync: statSyncMock,
  accessSync: accessSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
  chmodSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  constants: { X_OK: 1 }
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/orca-user-data')
  }
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

vi.mock('./macos-tcc-login-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof MacosTccLoginShell>()),
  prepareMacosTccLoginShell: prepareMacosTccLoginShellMock
}))

vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

// Resolve PowerShell family names to deterministic absolute paths (the fs mock
// above otherwise makes every probe miss). The real resolver — which skips the
// Store App Execution Alias stub — is covered in
// windows-powershell-executable.test.ts.
const WINDOWS_POWERSHELL_ABS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const PWSH7_ABS = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const CMD_ABS = 'C:\\Windows\\System32\\cmd.exe'
vi.mock('./windows-powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe' ? PWSH7_ABS : WINDOWS_POWERSHELL_ABS,
  resolveWindowsPowerShellSpawnChain: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe'
      ? [PWSH7_ABS, WINDOWS_POWERSHELL_ABS, CMD_ABS]
      : [WINDOWS_POWERSHELL_ABS, CMD_ABS],
  getWindowsCmdPath: () => CMD_ABS
}))

vi.mock('./agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: (...args: unknown[]) =>
    resolveAgentForegroundProcessMock(...args)
}))

vi.mock('./windows-conpty-process-membership', () => ({
  readWindowsConptyProcessIds: (...args: unknown[]) => readWindowsConptyProcessIdsMock(...args)
}))

vi.mock('../wsl', () => ({
  parseWslPath: (path: string) => {
    const match = path.match(/^\\\\wsl\.localhost\\([^\\]+)(.*)$/)
    if (!match) {
      return null
    }
    return {
      distro: match[1],
      linuxPath: (match[2] || '').replace(/\\/g, '/') || '/'
    }
  },
  toLinuxPath: (path: string) => path.replace(/^C:\\/i, '/mnt/c/').replace(/\\/g, '/'),
  toWindowsWslPath: (path: string, distro: string) =>
    `\\\\wsl.localhost\\${distro}${path.replace(/\//g, '\\')}`,
  getDefaultWslDistro: () => 'Ubuntu',
  isWslAvailableAsync: () => isWslAvailableAsyncMock(),
  // Why: WSL worktree validation now asks the distro; these tests use WSL UNC
  // cwds that are meant to exist, so report them present without spawning wsl.exe.
  wslUncDirectoryExists: (...args: unknown[]) => wslUncDirectoryExistsMock(...args)
}))

vi.mock('../shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: createShellPromptReadinessProbeMock
}))

import { LocalPtyProvider } from './local-pty-provider'
import {
  applyLocalPtyProviderMockDefaults,
  createLocalPtyMockProcess,
  installLocalPtyProviderEnvSandbox,
  type LocalPtyMockProcess
} from './local-pty-provider-test-harness'

describe('LocalPtyProvider', () => {
  let provider: LocalPtyProvider
  let mockProc: LocalPtyMockProcess
  let exitCb: ((info: { exitCode: number }) => void) | undefined

  installLocalPtyProviderEnvSandbox()

  beforeEach(() => {
    applyLocalPtyProviderMockDefaults({
      existsSyncMock,
      statSyncMock,
      accessSyncMock,
      mkdirSyncMock,
      writeFileSyncMock,
      prepareMacosTccLoginShellMock,
      resolveAgentForegroundProcessMock,
      readWindowsConptyProcessIdsMock,
      killWithDescendantSweepMock,
      isWslAvailableAsyncMock,
      wslUncDirectoryExistsMock,
      createShellPromptReadinessProbeMock
    })

    exitCb = undefined
    mockProc = createLocalPtyMockProcess({
      get: () => exitCb,
      set: (cb) => {
        exitCb = cb
      }
    })
    spawnMock.mockReturnValue(mockProc)

    provider = new LocalPtyProvider()
  })

  describe('spawn', () => {
    it('expands variables in PATH before spawning a Windows shell', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

      await provider.spawn({
        cols: 80,
        rows: 24,
        cwd: 'C:\\repo',
        env: {
          ORCA_AGENT_TEAMS_TEAM_ID: 'team-test',
          ORCA_PATH_ROOT: 'C:\\Users\\orca\\AppData\\Local',
          PATH: '%orca_path_root%\\agy\\bin;C:\\Windows'
        }
      })

      expect(spawnMock.mock.calls.at(-1)?.[2].env.PATH).toBe(
        'C:\\Users\\orca\\AppData\\Local\\agy\\bin;C:\\Windows'
      )
    })

    it('invokes buildSpawnEnv callback to customize environment', async () => {
      const buildSpawnEnv = vi.fn((_id: string, env: Record<string, string>) => {
        env.CUSTOM_VAR = 'custom-value'
        return env
      })
      provider.configure({ buildSpawnEnv })
      await provider.spawn({ cols: 80, rows: 24 })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[2].env.CUSTOM_VAR).toBe('custom-value')
    })

    it.each([
      // fish EXPORTS fish_history, so an Orca launched from a fish pane hands every
      // pane the LAUNCHING worktree's session — even with isolation off (STA-4682).
      ['an inherited Orca session', 'orca_abc123', undefined],
      ['a user value', 'mine', 'mine']
    ])('history isolation off: %s', async (_kind, inherited, expected) => {
      const previous = process.env.fish_history
      process.env.fish_history = inherited
      try {
        // No worktreeId: the history-disabled branch of spawn.
        await provider.spawn({ cols: 80, rows: 24 })
      } finally {
        if (previous === undefined) {
          delete process.env.fish_history
        } else {
          process.env.fish_history = previous
        }
      }

      expect(spawnMock.mock.calls.at(-1)![2].env.fish_history).toBe(expected)
    })

    it.each([
      // HISTFILE is exported, so an Orca launched from a pane in another worktree
      // hands every pane that worktree's history file — isolation off included.
      [
        'an inherited Orca path',
        '/fake/userData/terminal-history/aabbccddeeff0011/zsh_history',
        undefined
      ],
      ['a user value', '/home/me/.zsh_history', '/home/me/.zsh_history']
    ])('history isolation off: %s HISTFILE', async (_kind, inherited, expected) => {
      const previous = process.env.HISTFILE
      process.env.HISTFILE = inherited
      try {
        // No worktreeId: the history-disabled branch of spawn.
        await provider.spawn({ cols: 80, rows: 24 })
      } finally {
        if (previous === undefined) {
          delete process.env.HISTFILE
        } else {
          process.env.HISTFILE = previous
        }
      }

      expect(spawnMock.mock.calls.at(-1)![2].env.HISTFILE).toBe(expected)
    })

    it('does not inherit NODE_ENV from the Orca process env', async () => {
      // Why: NODE_ENV in Orca's process is Orca's build mode (electron-vite sets
      // `development` in dev runs); leaking it breaks `next build` and Vitest.
      const previous = process.env.NODE_ENV
      process.env.NODE_ENV = 'development'
      try {
        await provider.spawn({ cols: 80, rows: 24 })
      } finally {
        if (previous === undefined) {
          delete process.env.NODE_ENV
        } else {
          process.env.NODE_ENV = previous
        }
      }

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[2].env.NODE_ENV).toBeUndefined()
      const expectedEnv = { PATH: process.env.PATH ?? '' }
      stripLegacyTerminalShimEnv(expectedEnv, process.platform)
      expect(spawnCall[2].env.PATH).toBe(expectedEnv.PATH)
    })

    it('keeps an explicitly requested NODE_ENV for spawned terminals', async () => {
      // Why: only the ambient value is stripped; a caller-supplied NODE_ENV still wins.
      const previous = process.env.NODE_ENV
      process.env.NODE_ENV = 'development'
      try {
        await provider.spawn({ cols: 80, rows: 24, env: { NODE_ENV: 'production' } })
      } finally {
        if (previous === undefined) {
          delete process.env.NODE_ENV
        } else {
          process.env.NODE_ENV = previous
        }
      }

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[2].env.NODE_ENV).toBe('production')
    })

    it('suppresses the first-run Powerlevel10k wizard for spawned terminals', async () => {
      await provider.spawn({ cols: 80, rows: 24 })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[2].env.POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD).toBe('true')
    })

    it('preserves an explicit Powerlevel10k wizard env value', async () => {
      await provider.spawn({
        cols: 80,
        rows: 24,
        env: { POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD: 'already-set' }
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[2].env.POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD).toBe('already-set')
    })

    it('honors requests to delete the Powerlevel10k wizard env value', async () => {
      await provider.spawn({
        cols: 80,
        rows: 24,
        envToDelete: ['POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD']
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[2].env.POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD).toBeUndefined()
    })

    it('honors explicit terminal env overrides after deleting requested defaults', async () => {
      provider.configure({
        buildSpawnEnv: (_id, env) => {
          env.TERM_PROGRAM = 'Orca'
          env.ORCA_STALE_TEST_ENV = '/tmp/orca-stale'
          env.PATH = `/tmp/orca-stale:${env.PATH ?? ''}`
          return env
        }
      })

      await provider.spawn({
        cols: 80,
        rows: 24,
        env: {
          TERM: 'screen-256color',
          PATH: '/tmp/orca-agent-teams-bin:/usr/bin',
          ORCA_AGENT_TEAMS_TEAM_ID: 'team-test'
        },
        envToDelete: ['TERM_PROGRAM', 'ORCA_STALE_TEST_ENV']
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[2].name).toBe('screen-256color')
      expect(spawnCall[2].env.TERM).toBe('screen-256color')
      expect(spawnCall[2].env.PATH.split(':')[0]).toBe('/tmp/orca-agent-teams-bin')
      expect(spawnCall[2].env.TERM_PROGRAM).toBeUndefined()
      expect(spawnCall[2].env.ORCA_STALE_TEST_ENV).toBeUndefined()
    })

    it('does not re-promote a legacy attribution path for Agent Teams', async () => {
      await provider.spawn({
        cols: 80,
        rows: 24,
        env: {
          PATH: '/tmp/orca-terminal-attribution/posix:/usr/bin',
          ORCA_AGENT_TEAMS_TEAM_ID: 'team-test'
        }
      })

      expect(spawnMock.mock.calls.at(-1)?.[2].env.PATH).toBe('/usr/bin')
    })

    it('drops stale inherited Git config indices behind a smaller explicit count', async () => {
      const keys = [
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_KEY_0',
        'GIT_CONFIG_VALUE_0',
        'GIT_CONFIG_KEY_1',
        'GIT_CONFIG_VALUE_1'
      ] as const
      const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
      process.env.GIT_CONFIG_COUNT = '2'
      process.env.GIT_CONFIG_KEY_0 = 'base.zero'
      process.env.GIT_CONFIG_VALUE_0 = 'zero'
      process.env.GIT_CONFIG_KEY_1 = 'base.one'
      process.env.GIT_CONFIG_VALUE_1 = 'one'

      try {
        await provider.spawn({
          cols: 80,
          rows: 24,
          env: {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'override.zero',
            GIT_CONFIG_VALUE_0: 'override'
          }
        })

        const spawnEnv = spawnMock.mock.calls.at(-1)?.[2]?.env as Record<string, string>
        expect(spawnEnv.GIT_CONFIG_COUNT).toBe('1')
        expect(spawnEnv.GIT_CONFIG_KEY_0).toBe('override.zero')
        expect(spawnEnv.GIT_CONFIG_KEY_1).toBeUndefined()
        expect(spawnEnv.GIT_CONFIG_VALUE_1).toBeUndefined()
      } finally {
        for (const key of keys) {
          if (saved[key] === undefined) {
            delete process.env[key]
          } else {
            process.env[key] = saved[key]
          }
        }
      }
    })

    it('does not inherit AppImage runtime env into Linux PTY shells', async () => {
      const saved = {
        APPIMAGE: process.env.APPIMAGE,
        APPDIR: process.env.APPDIR,
        ARGV0: process.env.ARGV0,
        OWD: process.env.OWD,
        APPIMAGE_LIBRARY_PATH: process.env.APPIMAGE_LIBRARY_PATH,
        PATH: process.env.PATH,
        LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH
      }
      process.env.APPIMAGE = '/data/apps/orca.appimage'
      process.env.APPDIR = '/tmp/.mount_orca123'
      process.env.ARGV0 = '/data/apps/orca.appimage'
      process.env.OWD = '/home/user/project'
      process.env.APPIMAGE_LIBRARY_PATH = '/tmp/.mount_orca123/usr/lib'
      process.env.PATH = ['/tmp/.mount_orca123', '/tmp/.mount_orca123/usr/sbin', '/usr/bin'].join(
        delimiter
      )
      process.env.LD_LIBRARY_PATH = ['/tmp/.mount_orca123/usr/lib', '/opt/audio/lib'].join(
        delimiter
      )

      try {
        await provider.spawn({ cols: 80, rows: 24 })
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) {
            delete process.env[key]
          } else {
            process.env[key] = value
          }
        }
      }

      const env = spawnMock.mock.calls.at(-1)?.[2].env
      expect(env.APPIMAGE).toBeUndefined()
      expect(env.APPDIR).toBeUndefined()
      expect(env.ARGV0).toBeUndefined()
      expect(env.OWD).toBeUndefined()
      expect(env.APPIMAGE_LIBRARY_PATH).toBeUndefined()
      expect(env.PATH).toBe('/usr/bin')
      expect(env.LD_LIBRARY_PATH).toBe('/opt/audio/lib')
    })

    it('uses shell wrapper when MiMo home must survive shell startup', async () => {
      provider.configure({
        buildSpawnEnv: (_id, env) => {
          env.MIMOCODE_HOME = '/tmp/orca-mimocode-overlay'
          env.ORCA_MIMOCODE_HOME = '/tmp/orca-mimocode-overlay'
          return env
        }
      })

      await provider.spawn({ cols: 80, rows: 24 })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[1]).toEqual(['-l'])
      expect(spawnCall[2].env.ZDOTDIR).toMatch(/shell-ready[\\/]zsh/)
      expect(spawnCall[2].env.ORCA_SHELL_FEATURES).not.toContain('ready')
    })

    it('promotes the agent-teams shim onto the Windows `Path` spelling', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      provider.configure({
        buildSpawnEnv: (_id, env) => {
          // Why: host env collapses Windows PATH onto `Path` and prepends its own shim dir.
          delete env.PATH
          env.Path = `/tmp/orca-stale:${env.Path ?? ''}`
          return env
        }
      })

      await provider.spawn({
        cols: 80,
        rows: 24,
        env: {
          Path: '/tmp/orca-agent-teams-bin:/usr/bin',
          ORCA_AGENT_TEAMS_TEAM_ID: 'team-test'
        }
      })

      const spawnEnv = spawnMock.mock.calls.at(-1)![2].env
      expect(Object.keys(spawnEnv).filter((key) => /^path$/i.test(key))).toEqual(['Path'])
      expect(spawnEnv.Path.split(':')[0]).toBe('/tmp/orca-agent-teams-bin')
    })

    it('does not inherit parent Orca pane identity when caller omits pane env', async () => {
      const saved = {
        ORCA_PANE_KEY: process.env.ORCA_PANE_KEY,
        ORCA_TAB_ID: process.env.ORCA_TAB_ID,
        ORCA_WORKTREE_ID: process.env.ORCA_WORKTREE_ID
      }
      process.env.ORCA_PANE_KEY = 'parent-tab:parent-leaf'
      process.env.ORCA_TAB_ID = 'parent-tab'
      process.env.ORCA_WORKTREE_ID = 'parent-worktree'

      try {
        await provider.spawn({ cols: 80, rows: 24 })
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) {
            delete process.env[key]
          } else {
            process.env[key] = value
          }
        }
      }

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[2].env.ORCA_PANE_KEY).toBeUndefined()
      expect(spawnCall[2].env.ORCA_TAB_ID).toBeUndefined()
      expect(spawnCall[2].env.ORCA_WORKTREE_ID).toBeUndefined()
    })

    it('preserves explicit child Orca pane identity over parent env', async () => {
      const saved = {
        ORCA_PANE_KEY: process.env.ORCA_PANE_KEY,
        ORCA_TAB_ID: process.env.ORCA_TAB_ID,
        ORCA_WORKTREE_ID: process.env.ORCA_WORKTREE_ID
      }
      process.env.ORCA_PANE_KEY = 'parent-tab:parent-leaf'
      process.env.ORCA_TAB_ID = 'parent-tab'
      process.env.ORCA_WORKTREE_ID = 'parent-worktree'

      try {
        await provider.spawn({
          cols: 80,
          rows: 24,
          env: {
            ORCA_PANE_KEY: 'child-tab:child-leaf',
            ORCA_TAB_ID: 'child-tab',
            ORCA_WORKTREE_ID: 'child-worktree'
          }
        })
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) {
            delete process.env[key]
          } else {
            process.env[key] = value
          }
        }
      }

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[2].env.ORCA_PANE_KEY).toBe('child-tab:child-leaf')
      expect(spawnCall[2].env.ORCA_TAB_ID).toBe('child-tab')
      expect(spawnCall[2].env.ORCA_WORKTREE_ID).toBe('child-worktree')
    })
  })
})
