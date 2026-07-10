/* oxlint-disable max-lines */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { delimiter } from 'node:path'

const {
  existsSyncMock,
  statSyncMock,
  accessSyncMock,
  mkdirSyncMock,
  writeFileSyncMock,
  spawnMock,
  resolveAgentForegroundProcessMock
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  accessSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  resolveAgentForegroundProcessMock: vi.fn()
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  statSync: statSyncMock,
  accessSync: accessSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
  chmodSync: vi.fn(),
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
  resolveAgentForegroundProcess: resolveAgentForegroundProcessMock
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
  isWslAvailable: () => true,
  // Why: WSL worktree validation now asks the distro; these tests use WSL UNC
  // cwds that are meant to exist, so report them present without spawning wsl.exe.
  wslUncDirectoryExists: () => true
}))

import { LocalPtyProvider } from './local-pty-provider'
import { isRootLikePath } from './pty-path-safety'
import { POWERLEVEL10K_WIZARD_DISABLE_ENV } from '../pty/powerlevel10k-wizard-env'

describe('LocalPtyProvider', () => {
  let provider: LocalPtyProvider
  let mockProc: {
    onData: ReturnType<typeof vi.fn>
    onExit: ReturnType<typeof vi.fn>
    write: ReturnType<typeof vi.fn>
    resize: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
    process: string
    pid: number
  }
  let exitCb: ((info: { exitCode: number }) => void) | undefined
  let origShell: string | undefined
  let origPowerlevelWizardDisable: string | undefined
  let origHistFile: string | undefined
  let origPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    origShell = process.env.SHELL
    origPowerlevelWizardDisable = process.env.POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD
    origHistFile = process.env.HISTFILE
    process.env.SHELL = '/bin/zsh'
    delete process.env.POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD
    // injectHistoryEnv preserves an inherited HISTFILE, so clear it for hermetic history assertions.
    delete process.env.HISTFILE

    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue({ isDirectory: () => true, mode: 0o755 })
    accessSyncMock.mockReturnValue(undefined)
    mkdirSyncMock.mockReset()
    writeFileSyncMock.mockReset()
    resolveAgentForegroundProcessMock.mockReset()
    resolveAgentForegroundProcessMock.mockImplementation(
      async (_pid: number, fallbackProcess: string | null) => fallbackProcess
    )

    exitCb = undefined
    mockProc = {
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn((cb: (info: { exitCode: number }) => void) => {
        exitCb = cb
        return {
          dispose: () => {
            if (exitCb === cb) {
              exitCb = undefined
            }
          }
        }
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(() => {
        exitCb?.({ exitCode: -1 })
      }),
      process: 'zsh',
      pid: 12345
    }
    spawnMock.mockReturnValue(mockProc)

    provider = new LocalPtyProvider()
  })

  afterEach(() => {
    if (origPlatform) {
      Object.defineProperty(process, 'platform', origPlatform)
    }
    if (origShell === undefined) {
      delete process.env.SHELL
    } else {
      process.env.SHELL = origShell
    }
    if (origPowerlevelWizardDisable === undefined) {
      delete process.env.POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD
    } else {
      process.env.POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD = origPowerlevelWizardDisable
    }
    if (origHistFile === undefined) {
      delete process.env.HISTFILE
    } else {
      process.env.HISTFILE = origHistFile
    }
  })

  describe('spawn', () => {
    it('returns a unique PTY id', async () => {
      const result = await provider.spawn({ cols: 80, rows: 24 })
      expect(result.id).toBeTruthy()
      expect(typeof result.id).toBe('string')
    })

    it('reattaches to an existing caller-supplied session id without spawning', async () => {
      const first = await provider.spawn({ cols: 80, rows: 24, sessionId: 'serve-session-1' })
      spawnMock.mockClear()

      const second = await provider.spawn({ cols: 120, rows: 40, sessionId: first.id })

      expect(second).toEqual({ id: 'serve-session-1', pid: 12345, isReattach: true })
      expect(mockProc.resize).toHaveBeenCalledWith(120, 40)
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('does not reattach numeric caller session ids that can collide after restart', async () => {
      const first = await provider.spawn({ cols: 80, rows: 24 })
      spawnMock.mockClear()

      const second = await provider.spawn({ cols: 120, rows: 40, sessionId: first.id })

      expect(second.id).not.toBe(first.id)
      expect(second.isReattach).toBeUndefined()
      expect(spawnMock).toHaveBeenCalledOnce()
    })

    it('calls node-pty spawn with correct args', async () => {
      await provider.spawn({ cols: 120, rows: 40, cwd: '/tmp' })
      expect(spawnMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          cols: 120,
          rows: 40,
          cwd: '/tmp'
        })
      )
    })

    it('throws when cwd does not exist', async () => {
      existsSyncMock.mockImplementation((p: string) => p !== '/nonexistent')
      await expect(provider.spawn({ cols: 80, rows: 24, cwd: '/nonexistent' })).rejects.toThrow(
        'does not exist'
      )
    })

    it('allows an explicitly requested plain shell at POSIX root', async () => {
      await provider.spawn({ cols: 80, rows: 24, cwd: '/' })

      expect(spawnMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ cwd: '/' })
      )
    })

    it('falls back to the safe default cwd for automatic agent startup without an explicit cwd', async () => {
      spawnMock.mockClear()
      const origHome = process.env.HOME
      // Pin HOME so we assert the exact resolved candidate, not just non-root-ness —
      // catches regressions where resolveSafePtyDefaultCwd picks an unintended home.
      process.env.HOME = '/home/testuser'

      try {
        // Why: an omitted cwd resolves to a guaranteed-safe default home (the
        // guard only rejects root-like paths), so the agent must still launch.
        await expect(
          provider.spawn({ cols: 80, rows: 24, command: 'codex' })
        ).resolves.toBeDefined()

        const spawnCall = spawnMock.mock.calls.at(-1)!
        expect(spawnCall[2].cwd).toBe('/home/testuser')
        expect(isRootLikePath(spawnCall[2].cwd)).toBe(false)
      } finally {
        if (origHome === undefined) {
          delete process.env.HOME
        } else {
          process.env.HOME = origHome
        }
      }
    })

    it('rejects automatic agent startup at POSIX root', async () => {
      spawnMock.mockClear()

      await expect(
        provider.spawn({ cols: 80, rows: 24, cwd: '/', command: 'claude' })
      ).rejects.toThrow(/requires a non-root workspace/)

      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('invokes onSpawned callback', async () => {
      const onSpawned = vi.fn()
      provider.configure({ onSpawned })
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      expect(onSpawned).toHaveBeenCalledWith(id)
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

    it('uses fallback shell readiness when startup-command shell spawn falls back', async () => {
      vi.useFakeTimers()
      try {
        process.env.SHELL = '/usr/bin/fish'
        spawnMock.mockImplementationOnce(() => {
          throw new Error('fish failed')
        })
        spawnMock.mockReturnValue(mockProc)

        await provider.spawn({ cols: 80, rows: 24, command: "printf 'linked issue context'" })

        expect(spawnMock.mock.calls[0]?.[0]).toBe('/bin/zsh')
        await Promise.resolve()
        vi.advanceTimersByTime(50)
        await Promise.resolve()
        expect(mockProc.write).not.toHaveBeenCalled()

        const dataCallback = mockProc.onData.mock.calls[0]?.[0] as (data: string) => void
        dataCallback('\x1b]777;orca-shell-ready\x07user@host % ')
        await Promise.resolve()
        vi.advanceTimersByTime(29)
        await Promise.resolve()
        expect(mockProc.write).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1)
        await Promise.resolve()
        expect(mockProc.write).toHaveBeenCalledWith("printf 'linked issue context'\n")
      } finally {
        vi.useRealTimers()
      }
    })

    it('releases held marker-prefix bytes when local shell readiness times out', async () => {
      vi.useFakeTimers()
      const onData = vi.fn()
      provider.configure({ onData })
      try {
        await provider.spawn({ cols: 80, rows: 24, command: 'printf ready' })
        const dataCallback = mockProc.onData.mock.calls[0]?.[0] as (data: string) => void

        dataCallback('\x1b]777;orca-shell-ready')
        expect(onData).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1500)
        await Promise.resolve()

        expect(onData).toHaveBeenCalledWith(
          expect.any(String),
          '\x1b]777;orca-shell-ready',
          expect.any(Number)
        )
        expect(mockProc.write).not.toHaveBeenCalled()

        vi.advanceTimersByTime(200)
        await Promise.resolve()
        expect(mockProc.write).toHaveBeenCalledWith('printf ready\n')
      } finally {
        vi.useRealTimers()
      }
    })

    it('releases held marker-prefix bytes when local shell exits before readiness', async () => {
      const onData = vi.fn()
      provider.configure({ onData })

      await provider.spawn({ cols: 80, rows: 24, command: 'printf ready' })
      const dataCallback = mockProc.onData.mock.calls[0]?.[0] as (data: string) => void

      dataCallback('\x1b]777;orca-shell-ready')
      expect(onData).not.toHaveBeenCalled()

      exitCb?.({ exitCode: 0 })

      expect(onData).toHaveBeenCalledWith(
        expect.any(String),
        '\x1b]777;orca-shell-ready',
        expect.any(Number)
      )
    })

    it('honors explicit terminal env overrides after deleting requested defaults', async () => {
      provider.configure({
        buildSpawnEnv: (_id, env) => {
          env.TERM_PROGRAM = 'Orca'
          env.ORCA_ATTRIBUTION_SHIM_DIR = '/tmp/orca-attribution'
          env.PATH = `/tmp/orca-attribution:${env.PATH ?? ''}`
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
        envToDelete: ['TERM_PROGRAM', 'ORCA_ATTRIBUTION_SHIM_DIR']
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[2].name).toBe('screen-256color')
      expect(spawnCall[2].env.TERM).toBe('screen-256color')
      expect(spawnCall[2].env.PATH.split(':')[0]).toBe('/tmp/orca-agent-teams-bin')
      expect(spawnCall[2].env.TERM_PROGRAM).toBeUndefined()
      expect(spawnCall[2].env.ORCA_ATTRIBUTION_SHIM_DIR).toBeUndefined()
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
      expect(spawnCall[2].env.ORCA_SHELL_READY_MARKER).toBe('0')
    })

    it('does not pass a Windows Codex home into WSL terminals', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      provider.configure({
        buildSpawnEnv: (_id, env) => {
          env.CODEX_HOME = 'C:\\Users\\jin\\.codex'
          env.ORCA_CODEX_HOME = 'C:\\Users\\jin\\.codex'
          return env
        }
      })

      await provider.spawn({
        cols: 80,
        rows: 24,
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[0]).toBe('wsl.exe')
      expect(spawnCall[2].env.CODEX_HOME).toBeUndefined()
      expect(spawnCall[2].env.ORCA_CODEX_HOME).toBeUndefined()
    })

    it('does not pass a WSL managed Codex home into Windows terminals', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      provider.configure({
        buildSpawnEnv: (_id, env) => {
          env.CODEX_HOME =
            '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
          env.ORCA_CODEX_HOME =
            '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
          return env
        }
      })

      await provider.spawn({
        cols: 80,
        rows: 24,
        cwd: 'C:\\Users\\jin\\repo'
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[2].env.CODEX_HOME).toBeUndefined()
      expect(spawnCall[2].env.ORCA_CODEX_HOME).toBeUndefined()
    })

    it('preserves an explicit Linux Codex home for WSL terminals', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      provider.configure({
        buildSpawnEnv: (_id, env) => {
          env.CODEX_HOME = '/home/jin/.codex-alt'
          return env
        }
      })

      await provider.spawn({
        cols: 80,
        rows: 24,
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[0]).toBe('wsl.exe')
      expect(spawnCall[2].env.CODEX_HOME).toBe('/home/jin/.codex-alt')
      expect(spawnCall[2].env.WSLENV).toContain('CODEX_HOME')
    })

    it('translates a WSL managed Codex home before launching a WSL terminal', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      provider.configure({
        buildSpawnEnv: (_id, env) => {
          env.CODEX_HOME =
            '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
          env.ORCA_CODEX_HOME =
            '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
          return env
        }
      })

      await provider.spawn({
        cols: 80,
        rows: 24,
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[0]).toBe('wsl.exe')
      expect(spawnCall[2].env.CODEX_HOME).toBe('/home/jin/.local/share/orca/codex-accounts/a/home')
      expect(spawnCall[2].env.ORCA_CODEX_HOME).toBe(
        '/home/jin/.local/share/orca/codex-accounts/a/home'
      )
      expect(spawnCall[2].env.WSLENV).toContain('CODEX_HOME')
      expect(spawnCall[2].env.WSLENV).toContain('ORCA_CODEX_HOME')
    })

    it('does not pass a WSL managed Codex home into a different WSL distro', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      provider.configure({
        buildSpawnEnv: (_id, env) => {
          env.CODEX_HOME =
            '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
          env.ORCA_CODEX_HOME =
            '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.local\\share\\orca\\codex-accounts\\a\\home'
          return env
        }
      })

      await provider.spawn({
        cols: 80,
        rows: 24,
        cwd: '\\\\wsl.localhost\\Debian\\home\\jin\\repo'
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[0]).toBe('wsl.exe')
      expect(spawnCall[2].env.CODEX_HOME).toBeUndefined()
      expect(spawnCall[2].env.ORCA_CODEX_HOME).toBeUndefined()
    })

    it('uses the preferred WSL distro for Windows cwd WSL terminals', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

      await provider.spawn({
        cols: 80,
        rows: 24,
        worktreeId: 'repo-1::C:\\Users\\jin\\repo',
        cwd: 'C:\\Users\\jin\\repo',
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Debian'
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[0]).toBe('wsl.exe')
      expect(spawnCall[1]).toEqual([
        '-d',
        'Debian',
        '--',
        'sh',
        '-c',
        expect.stringContaining("cd '/mnt/c/Users/jin/repo'")
      ])
      expect(spawnCall[1][5]).toContain('exec "\\$_orca_wsl_shell" -l')
      expect(spawnCall[2].env.HISTFILE).toContain('terminal-history-wsl/Debian')
    })

    it('repro: keeps explicit PowerShell 7 selection when the pwsh probe is cold-false', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const pwshAvailable = vi.fn(() => false)
      provider.configure({
        getWindowsShell: () => 'powershell.exe',
        getWindowsPowerShellImplementation: () => 'pwsh.exe',
        pwshAvailable
      })

      await provider.spawn({
        cols: 80,
        rows: 24,
        cwd: 'C:\\Users\\jin\\repo'
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[0]).toBe(PWSH7_ABS)
      expect(spawnCall[1]).toContain('-EncodedCommand')
      expect(pwshAvailable).not.toHaveBeenCalled()
    })

    it('marks Orca terminal handle for WSL import when buildSpawnEnv opts in', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const savedCodexHome = process.env.CODEX_HOME
      const savedOrcaCodexHome = process.env.ORCA_CODEX_HOME
      delete process.env.CODEX_HOME
      delete process.env.ORCA_CODEX_HOME
      provider.configure({
        buildSpawnEnv: (_id, env, ctx) => {
          env.ORCA_TERMINAL_HANDLE = 'term_wsl'
          if (ctx?.isWsl) {
            env.WSLENV = 'ORCA_TERMINAL_HANDLE/u'
          }
          return env
        }
      })

      try {
        await provider.spawn({
          cols: 80,
          rows: 24,
          cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
        })
      } finally {
        if (savedCodexHome === undefined) {
          delete process.env.CODEX_HOME
        } else {
          process.env.CODEX_HOME = savedCodexHome
        }
        if (savedOrcaCodexHome === undefined) {
          delete process.env.ORCA_CODEX_HOME
        } else {
          process.env.ORCA_CODEX_HOME = savedOrcaCodexHome
        }
      }

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[0]).toBe('wsl.exe')
      expect(spawnCall[2].env.ORCA_TERMINAL_HANDLE).toBe('term_wsl')
      expect(spawnCall[2].env.WSLENV).toBe(
        'ORCA_TERMINAL_HANDLE/u:POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD'
      )
    })

    it('does not mark deleted Powerlevel10k wizard env for WSL import', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

      await provider.spawn({
        cols: 80,
        rows: 24,
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo',
        envToDelete: [POWERLEVEL10K_WIZARD_DISABLE_ENV]
      })

      const spawnCall = spawnMock.mock.calls.at(-1)!
      expect(spawnCall[0]).toBe('wsl.exe')
      expect(spawnCall[2].env[POWERLEVEL10K_WIZARD_DISABLE_ENV]).toBeUndefined()
      expect(spawnCall[2].env.WSLENV ?? '').not.toContain(POWERLEVEL10K_WIZARD_DISABLE_ENV)
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

    it('combines HOMEDRIVE and HOMEPATH for Windows default cwd', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      const originalUserProfile = process.env.USERPROFILE
      const originalHomeDrive = process.env.HOMEDRIVE
      const originalHomePath = process.env.HOMEPATH

      Object.defineProperty(process, 'platform', { value: 'win32' })
      delete process.env.USERPROFILE
      process.env.HOMEDRIVE = 'D:'
      process.env.HOMEPATH = '\\Users\\orca'

      try {
        await provider.spawn({ cols: 80, rows: 24 })
      } finally {
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
        if (originalUserProfile === undefined) {
          delete process.env.USERPROFILE
        } else {
          process.env.USERPROFILE = originalUserProfile
        }
        if (originalHomeDrive === undefined) {
          delete process.env.HOMEDRIVE
        } else {
          process.env.HOMEDRIVE = originalHomeDrive
        }
        if (originalHomePath === undefined) {
          delete process.env.HOMEPATH
        } else {
          process.env.HOMEPATH = originalHomePath
        }
      }

      expect(spawnMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ cwd: 'D:\\Users\\orca' })
      )
    })

    it('launches POSIX cwd split panes through WSL when worktree context is WSL', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })

      try {
        await provider.spawn({
          cols: 80,
          rows: 24,
          cwd: '/home/jin/repo/subdir',
          shellOverride: 'powershell.exe',
          worktreeId: 'repo::\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
        })
      } finally {
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
      }

      expect(spawnMock).toHaveBeenCalledWith(
        'wsl.exe',
        ['-d', 'Ubuntu', '--', 'sh', '-c', expect.stringContaining("cd '/home/jin/repo/subdir'")],
        expect.objectContaining({ cwd: expect.any(String) })
      )
    })

    it('resolves the Git Bash default shell and preserves the requested cwd', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      const originalProgramFiles = process.env.ProgramFiles
      Object.defineProperty(process, 'platform', { value: 'win32' })
      process.env.ProgramFiles = 'C:\\Program Files'
      provider.configure({ getWindowsShell: () => 'git-bash' })

      try {
        await provider.spawn({
          cols: 80,
          rows: 24,
          cwd: 'C:\\Users\\jin\\repo'
        })
      } finally {
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
        if (originalProgramFiles === undefined) {
          delete process.env.ProgramFiles
        } else {
          process.env.ProgramFiles = originalProgramFiles
        }
      }

      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\Program Files\\Git\\bin\\bash.exe',
        ['--login', '-i'],
        expect.objectContaining({
          cwd: 'C:\\Users\\jin\\repo',
          env: expect.objectContaining({
            CHERE_INVOKING: '1',
            PYTHONUTF8: '1'
          })
        })
      )
    })
  })

  describe('write', () => {
    it('writes data to the PTY process', async () => {
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      provider.write(id, 'hello')
      expect(mockProc.write).toHaveBeenCalledWith('hello')
    })

    it('is a no-op for unknown PTY ids', () => {
      provider.write('nonexistent', 'hello')
      expect(mockProc.write).not.toHaveBeenCalled()
    })
  })

  describe('resize', () => {
    it('resizes the PTY process', async () => {
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      provider.resize(id, 120, 40)
      expect(mockProc.resize).toHaveBeenCalledWith(120, 40)
    })
  })

  describe('shutdown', () => {
    it('kills the PTY process', async () => {
      // Why: capture the spy reference before shutdown triggers onExit →
      // POSIX kill neutralization. After neutralization, mockProc.kill is
      // replaced with a non-spy no-op to close the UnixTerminal.destroy() →
      // socket-close → SIGHUP-to-recycled-pid race (see docs/fix-pty-fd-leak.md).
      const killSpy = mockProc.kill
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      await provider.shutdown(id, { immediate: true })
      expect(killSpy).toHaveBeenCalled()
    })

    it('invokes onExit callback via the node-pty exit handler', async () => {
      const onExit = vi.fn()
      provider.configure({ onExit })
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      await provider.shutdown(id, { immediate: true })
      expect(onExit).toHaveBeenCalledWith(id, -1)
    })

    it('does not destroy after an intentional Windows shutdown kill', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const killSpy = vi.fn()
      const destroySpy = vi.fn(() => {
        killSpy()
      })
      spawnMock.mockReturnValue({
        ...mockProc,
        kill: killSpy,
        destroy: destroySpy
      })

      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      await provider.shutdown(id, { immediate: true })

      expect(killSpy).toHaveBeenCalledTimes(1)
      expect(destroySpy).not.toHaveBeenCalled()
    })

    it('cancels pending shell-ready startup delivery on forced shutdown', async () => {
      vi.useFakeTimers()
      try {
        const { id } = await provider.spawn({ cols: 80, rows: 24, command: 'printf ready' })

        await provider.shutdown(id, { immediate: true })
        vi.advanceTimersByTime(2000)
        await Promise.resolve()

        expect(mockProc.write).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('is a no-op for unknown PTY ids', async () => {
      await provider.shutdown('nonexistent', { immediate: true })
      expect(mockProc.kill).not.toHaveBeenCalled()
    })
  })

  describe('hasChildProcesses', () => {
    it('returns false when foreground process matches shell', async () => {
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      expect(await provider.hasChildProcesses(id)).toBe(false)
    })

    it('returns true when foreground process differs from shell', async () => {
      mockProc.process = 'node'
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      expect(await provider.hasChildProcesses(id)).toBe(true)
    })

    it('returns false for unknown PTY ids', async () => {
      expect(await provider.hasChildProcesses('nonexistent')).toBe(false)
    })
  })

  describe('getForegroundProcess', () => {
    it('returns the process name', async () => {
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      expect(await provider.getForegroundProcess(id)).toBe('zsh')
    })

    it('uses the spawned Windows shell when node-pty reports only the terminal name', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      mockProc.process = 'xterm-256color'

      const { id } = await provider.spawn({
        cols: 80,
        rows: 24,
        shellOverride: 'powershell.exe'
      })

      expect(await provider.getForegroundProcess(id)).toBe('powershell.exe')
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledWith(
        mockProc.pid,
        'powershell.exe',
        expect.any(Object)
      )
    })

    it('returns null for unknown PTY ids', async () => {
      expect(await provider.getForegroundProcess('nonexistent')).toBeNull()
    })
  })

  describe('event listeners', () => {
    it('notifies data listeners when PTY produces output', async () => {
      const dataHandler = vi.fn()
      provider.onData(dataHandler)
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      // Simulate node-pty data event
      const onDataCb = mockProc.onData.mock.calls[0][0]
      onDataCb('hello world')

      expect(dataHandler).toHaveBeenCalledWith({ id, data: 'hello world' })
    })

    it('notifies exit listeners when PTY exits', async () => {
      const exitHandler = vi.fn()
      provider.onExit(exitHandler)
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      // Simulate node-pty exit event
      exitCb?.({ exitCode: 0 })

      expect(exitHandler).toHaveBeenCalledWith({ id, code: 0 })
    })

    it('allows unsubscribing from events', async () => {
      const dataHandler = vi.fn()
      const unsub = provider.onData(dataHandler)
      const { id: _id } = await provider.spawn({ cols: 80, rows: 24 })

      unsub()
      const onDataCb = mockProc.onData.mock.calls[0][0]
      onDataCb('hello')

      expect(dataHandler).not.toHaveBeenCalled()
    })
  })

  describe('listProcesses', () => {
    it('returns spawned PTYs', async () => {
      const before = await provider.listProcesses()
      await provider.spawn({ cols: 80, rows: 24 })
      await provider.spawn({ cols: 80, rows: 24 })
      const after = await provider.listProcesses()
      expect(after.length - before.length).toBe(2)
      const newEntries = after.slice(before.length)
      expect(newEntries[0]).toHaveProperty('id')
      expect(newEntries[0]).toHaveProperty('title', 'zsh')
    })
  })

  describe('getDefaultShell', () => {
    it('returns SHELL env var on Unix', async () => {
      const originalShell = process.env.SHELL
      try {
        process.env.SHELL = '/bin/bash'
        expect(await provider.getDefaultShell()).toBe('/bin/bash')
      } finally {
        if (originalShell === undefined) {
          delete process.env.SHELL
        } else {
          process.env.SHELL = originalShell
        }
      }
    })
  })

  describe('killAll', () => {
    it('kills all PTY processes', async () => {
      // Why: each spawn needs its own proc so the onExit-triggered POSIX kill
      // neutralization on one proc does not replace the kill function on the
      // other (mockProc is shared by default in beforeEach). Each proc also
      // needs its own exitCb holder — the default mockProc.onExit assigns to
      // the shared `exitCb` variable, so the second spawn would overwrite the
      // first's exit callback, and mock1Kill firing would trigger cleanup for
      // id2 (removing it from the map before killAll iterates to it).
      let exit1: ((e: { exitCode: number }) => void) | undefined
      let exit2: ((e: { exitCode: number }) => void) | undefined
      const mock1Kill = vi.fn(() => exit1?.({ exitCode: -1 }))
      const mock2Kill = vi.fn(() => exit2?.({ exitCode: -1 }))
      spawnMock
        .mockReturnValueOnce({
          ...mockProc,
          kill: mock1Kill,
          onExit: vi.fn((cb) => {
            exit1 = cb
          })
        })
        .mockReturnValueOnce({
          ...mockProc,
          kill: mock2Kill,
          onExit: vi.fn((cb) => {
            exit2 = cb
          })
        })

      await provider.spawn({ cols: 80, rows: 24 })
      await provider.spawn({ cols: 80, rows: 24 })

      provider.killAll()

      expect(mock1Kill).toHaveBeenCalled()
      expect(mock2Kill).toHaveBeenCalled()
      const list = await provider.listProcesses()
      expect(list).toHaveLength(0)
    })

    it('does not destroy after intentional Windows orphan kills', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const destroySpy = vi.fn()
      const killSpy = vi.fn()
      spawnMock.mockReturnValue({
        ...mockProc,
        kill: killSpy,
        destroy: destroySpy
      })

      await provider.spawn({ cols: 80, rows: 24 })

      provider.killAll()

      expect(killSpy).toHaveBeenCalledTimes(1)
      expect(destroySpy).not.toHaveBeenCalled()
    })
  })
})
