import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { buildWslCodexAvailabilityScript, buildWslCodexLoginArgs } from './wsl-codex-command'
import type { WslResult, WslSpec } from '../wsl/wsl-runner'
import {
  createCodexAuthJson,
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

function decodeEncodedWslBashCommand(command: string): string {
  const encoded = command.match(/^set -o pipefail; printf %s '([^']+)' \| base64 -d \| bash$/)?.[1]
  return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : command
}

function wslOk(stdout = ''): WslResult {
  return { environmentResolved: true, code: 0, stdout, stderr: '', timedOut: false }
}

function wslFailed(code: number, stderr = ''): WslResult {
  return { environmentResolved: true, code, stdout: '', stderr, timedOut: false }
}

describe('CodexAccountService config sync', () => {
  registerCodexAccountsTestHomes()

  it('preserves WSL account-home project trust while refreshing canonical settings', async () => {
    const wslManagedHomePath = join(testState.userDataDir, 'wsl-account', 'home')
    const wslCanonicalHomePath = join(testState.userDataDir, 'wsl-home', '.codex')
    const wslLinuxHomePath = '/home/alice/.local/share/orca/codex-accounts/account-1/home'
    const wslLinuxCanonicalHomePath = '/home/alice/.codex'
    mkdirSync(wslManagedHomePath, { recursive: true })
    mkdirSync(wslCanonicalHomePath, { recursive: true })
    writeFileSync(join(wslManagedHomePath, '.orca-managed-home'), 'account-1\n', 'utf-8')
    writeFileSync(
      join(wslManagedHomePath, 'config.toml'),
      'approval_policy = "untrusted"\n[projects."/workspace"]\ntrust_level = "trusted"\n',
      'utf-8'
    )
    writeFileSync(
      join(wslCanonicalHomePath, 'config.toml'),
      'sandbox_mode = "danger-full-access"\n',
      'utf-8'
    )

    vi.doMock('../../shared/wsl-paths', () => ({
      parseWslUncPath: (path: string) => {
        if (path === wslManagedHomePath) {
          return { distro: 'Ubuntu', linuxPath: wslLinuxHomePath }
        }
        if (path === wslCanonicalHomePath) {
          return { distro: 'Ubuntu', linuxPath: wslLinuxCanonicalHomePath }
        }
        return null
      }
    }))
    vi.doMock('../wsl', () => ({
      toWindowsWslPath: (linuxPath: string) =>
        linuxPath === wslLinuxCanonicalHomePath ||
        linuxPath === `${wslLinuxCanonicalHomePath}/config.toml`
          ? linuxPath.endsWith('/config.toml')
            ? join(wslCanonicalHomePath, 'config.toml')
            : wslCanonicalHomePath
          : wslManagedHomePath
    }))

    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'wsl@example.com',
          managedHomePath: wslManagedHomePath,
          managedHomeRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    })

    const { CodexAccountService } = await import('./service')
    new CodexAccountService(
      createStore(settings) as never,
      createRateLimits() as never,
      createRuntimeHome() as never
    )

    expect(readFileSync(join(wslManagedHomePath, 'config.toml'), 'utf-8')).toBe(
      'sandbox_mode = "danger-full-access"\n\n' +
        '[projects."/workspace"]\ntrust_level = "trusted"\n'
    )
  })

  it('keeps Linux-relative config paths when a WSL home is under a mounted drive', async () => {
    vi.resetModules()
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    const wslManagedHomePath = join(testState.userDataDir, 'wsl-account', 'home')
    const wslCanonicalHomePath = join(testState.userDataDir, 'wsl-home', '.codex')
    const wslCanonicalConfigPath = join(wslCanonicalHomePath, 'config.toml')
    const wslLinuxHomePath = '/mnt/c/Users/alice/.local/share/orca/codex-accounts/account-1/home'
    const wslLinuxCanonicalHomePath = '/mnt/c/Users/alice/.codex'
    mkdirSync(wslManagedHomePath, { recursive: true })
    mkdirSync(wslCanonicalHomePath, { recursive: true })
    writeFileSync(join(wslManagedHomePath, '.orca-managed-home'), 'account-1\n', 'utf-8')
    writeFileSync(wslCanonicalConfigPath, 'model_instructions_file = "instructions.md"\n', 'utf-8')

    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(() => `${wslLinuxHomePath}\n`),
      spawn: vi.fn()
    }))
    vi.doMock('../../shared/wsl-paths', () => ({
      parseWslUncPath: (path: string) =>
        path === wslManagedHomePath ? { distro: 'Ubuntu', linuxPath: wslLinuxHomePath } : null
    }))
    vi.doMock('../wsl', () => ({
      toWindowsWslPath: (linuxPath: string) =>
        linuxPath.endsWith('/config.toml')
          ? wslCanonicalConfigPath
          : linuxPath === wslLinuxCanonicalHomePath
            ? wslCanonicalHomePath
            : wslManagedHomePath
    }))

    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'wsl@example.com',
          managedHomePath: wslManagedHomePath,
          managedHomeRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    })

    try {
      const { CodexAccountService } = await import('./service')
      new CodexAccountService(
        createStore(settings) as never,
        createRateLimits() as never,
        createRuntimeHome() as never
      )

      expect(readFileSync(join(wslManagedHomePath, 'config.toml'), 'utf-8')).toContain(
        "model_instructions_file = '/mnt/c/Users/alice/.codex/instructions.md'"
      )
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('adds a managed Codex account inside WSL when the account context is WSL', async () => {
    vi.resetModules()
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    const wslManagedHomePath = join(testState.userDataDir, 'wsl-managed-home')
    const wslConfigHomePath = join(testState.userDataDir, 'wsl-config-home')
    const wslConfigPath = join(wslConfigHomePath, 'config.toml')
    const wslLinuxHomePath = '/home/alice/.local/share/orca/codex-accounts/account-id-for-test/home'
    mkdirSync(wslConfigHomePath, { recursive: true })
    writeFileSync(
      wslConfigPath,
      'sandbox_mode = "danger-full-access"\nmodel_instructions_file = "instructions.md"\n',
      'utf-8'
    )

    const execFileSyncMock = vi.fn((_command: string, args: string[]) => {
      const script = decodeEncodedWslBashCommand(String(args.at(-1)))
      expect(args.slice(0, 2)).toEqual(['-d', 'Debian'])
      expect(script).toContain('readlink -f')
      return `${wslLinuxHomePath}\n`
    })
    const runWslProcessMock = vi.fn(async (spec: WslSpec) => {
      const script = String(spec.script)
      expect(spec.distro).toBe('Debian')
      if (script.includes('WSL_DISTRO_NAME')) {
        // 'none': reads $HOME and $WSL_DISTRO_NAME, which wsl.exe supplies from
        // /etc/passwd without a login shell.
        expect(spec.loginPath).toBe('none')
        return wslOk('Debian\n/home/alice\n')
      }
      if (script.includes('_orca_lookup_command=')) {
        // 'preferred': a PATH lookup. Under 'none' an nvm-installed codex is
        // invisible and a working install is reported absent (#9725).
        expect(spec.loginPath).toBe('preferred')
        expect(script).toBe(buildWslCodexAvailabilityScript())
        return wslOk()
      }
      expect(spec.loginPath).toBe('none')
      expect(script).toContain('mkdir -p ')
      mkdirSync(wslManagedHomePath, { recursive: true })
      writeFileSync(join(wslManagedHomePath, '.orca-managed-home'), 'account-id-for-test\n')
      return wslOk()
    })
    const spawnMock = vi.fn((command: string, args: string[]) => {
      expect(command).toBe('wsl.exe')
      expect(args).toEqual(buildWslCodexLoginArgs('Debian', wslLinuxHomePath))
      // Why: codex login runs inside WSL, so the rewritten path must be the
      // Linux-side ~/.codex, not a Windows UNC path.
      expect(readFileSync(join(wslManagedHomePath, 'config.toml'), 'utf-8')).toBe(
        'sandbox_mode = "danger-full-access"\n' +
          "model_instructions_file = '/home/alice/.codex/instructions.md'\n"
      )
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
        kill: () => void
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = vi.fn()

      const payload = Buffer.from(JSON.stringify({ email: 'wsl@example.com' })).toString(
        'base64url'
      )
      writeFileSync(
        join(wslManagedHomePath, 'auth.json'),
        JSON.stringify({ tokens: { id_token: `header.${payload}.signature` } }),
        'utf-8'
      )
      queueMicrotask(() => child.emit('close', 0))
      return child
    })

    vi.doMock('node:crypto', () => ({
      randomUUID: () => 'account-id-for-test'
    }))
    vi.doMock('node:child_process', () => ({
      execFileSync: execFileSyncMock,
      spawn: spawnMock
    }))
    vi.doMock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))
    vi.doMock('../../shared/wsl-paths', () => ({
      parseWslUncPath: (path: string) =>
        path === wslManagedHomePath
          ? { distro: 'Debian', linuxPath: wslLinuxHomePath }
          : path === wslConfigHomePath
            ? { distro: 'Debian', linuxPath: '/home/alice/.codex' }
            : null
    }))
    vi.doMock('../wsl', () => ({
      toWindowsWslPath: (linuxPath: string) =>
        linuxPath.endsWith('/.codex/config.toml')
          ? wslConfigPath
          : linuxPath.endsWith('/.codex')
            ? wslConfigHomePath
            : wslManagedHomePath
    }))

    const settings = createSettings()
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    try {
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      const result = await service.addAccount({ runtime: 'wsl', wslDistro: 'Debian' })

      expect(result.accounts[0]).toMatchObject({
        email: 'wsl@example.com',
        managedHomeRuntime: 'wsl',
        wslDistro: 'Debian'
      })
      expect(store.getSettings().codexManagedAccounts[0]).toMatchObject({
        managedHomePath: wslManagedHomePath,
        wslLinuxHomePath,
        managedHomeRuntime: 'wsl'
      })
      // Why: a WSL add must sync the WSL runtime home, not the default host lane,
      // or the account it just selected stays unmaterialized until the next switch.
      expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledWith({
        runtime: 'wsl',
        wslDistro: 'Debian'
      })
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('fails WSL Codex account add with an actionable message when codex is missing in the distro', async () => {
    vi.resetModules()
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    const wslManagedHomePath = join(testState.userDataDir, 'wsl-managed-home')
    const wslLinuxHomePath = '/home/alice/.local/share/orca/codex-accounts/account-id-for-test/home'

    const execFileSyncMock = vi.fn((_command: string, args: string[]) => {
      const script = decodeEncodedWslBashCommand(String(args.at(-1)))
      expect(args.slice(0, 2)).toEqual(['-d', 'Debian'])
      expect(script).toContain('readlink -f')
      return `${wslLinuxHomePath}\n`
    })
    const runWslProcessMock = vi.fn(async (spec: WslSpec) => {
      const script = String(spec.script)
      expect(spec.distro).toBe('Debian')
      if (script.includes('WSL_DISTRO_NAME')) {
        return wslOk('Debian\n/home/alice\n')
      }
      if (script.includes('_orca_lookup_command=')) {
        expect(script).toBe(buildWslCodexAvailabilityScript())
        return wslFailed(1, 'codex missing')
      }
      mkdirSync(wslManagedHomePath, { recursive: true })
      writeFileSync(join(wslManagedHomePath, '.orca-managed-home'), 'account-id-for-test\n')
      return wslOk()
    })
    const spawnMock = vi.fn()

    vi.doMock('node:crypto', () => ({
      randomUUID: () => 'account-id-for-test'
    }))
    vi.doMock('node:child_process', () => ({
      execFileSync: execFileSyncMock,
      spawn: spawnMock
    }))
    vi.doMock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))
    vi.doMock('../../shared/wsl-paths', () => ({
      parseWslUncPath: (path: string) =>
        path === wslManagedHomePath ? { distro: 'Debian', linuxPath: wslLinuxHomePath } : null
    }))
    vi.doMock('../wsl', () => ({
      toWindowsWslPath: () => wslManagedHomePath
    }))

    const settings = createSettings()
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    try {
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      await expect(service.addAccount({ runtime: 'wsl', wslDistro: 'Debian' })).rejects.toThrow(
        'Codex CLI is not available in WSL Debian'
      )
      expect(spawnMock).not.toHaveBeenCalled()
      expect(existsSync(wslManagedHomePath)).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('says it could not check, not "not installed", when the login PATH is unavailable', async () => {
    // #9725: an nvm-installed codex lives only on the login PATH. When the
    // probe cannot supply it, a non-zero lookup is "we could not check" --
    // reporting a working install as absent is the bug this pins.
    vi.resetModules()
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    const wslManagedHomePath = join(testState.userDataDir, 'wsl-managed-home')
    const wslLinuxHomePath = '/home/alice/.local/share/orca/codex-accounts/account-id-for-test/home'

    const execFileSyncMock = vi.fn((_command: string, args: string[]) => {
      const script = decodeEncodedWslBashCommand(String(args.at(-1)))
      expect(args.slice(0, 2)).toEqual(['-d', 'Debian'])
      expect(script).toContain('readlink -f')
      return `${wslLinuxHomePath}\n`
    })
    const runWslProcessMock = vi.fn(async (spec: WslSpec) => {
      const script = String(spec.script)
      expect(spec.distro).toBe('Debian')
      if (script.includes('WSL_DISTRO_NAME')) {
        return wslOk('Debian\n/home/alice\n')
      }
      if (script.includes('_orca_lookup_command=')) {
        expect(script).toBe(buildWslCodexAvailabilityScript())
        return { ...wslFailed(1, 'codex missing'), environmentResolved: false }
      }
      mkdirSync(wslManagedHomePath, { recursive: true })
      writeFileSync(join(wslManagedHomePath, '.orca-managed-home'), 'account-id-for-test\n')
      return wslOk()
    })
    const spawnMock = vi.fn()

    vi.doMock('node:crypto', () => ({
      randomUUID: () => 'account-id-for-test'
    }))
    vi.doMock('node:child_process', () => ({
      execFileSync: execFileSyncMock,
      spawn: spawnMock
    }))
    vi.doMock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))
    vi.doMock('../../shared/wsl-paths', () => ({
      parseWslUncPath: (path: string) =>
        path === wslManagedHomePath ? { distro: 'Debian', linuxPath: wslLinuxHomePath } : null
    }))
    vi.doMock('../wsl', () => ({
      toWindowsWslPath: () => wslManagedHomePath
    }))

    const settings = createSettings()
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    try {
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      await expect(service.addAccount({ runtime: 'wsl', wslDistro: 'Debian' })).rejects.toThrow(
        'Could not check the Codex CLI in WSL. Try again.'
      )
      expect(spawnMock).not.toHaveBeenCalled()
      expect(existsSync(wslManagedHomePath)).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('reauthenticates a WSL managed Codex account inside its distro', async () => {
    vi.resetModules()
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    const wslManagedHomePath = join(testState.userDataDir, 'wsl-account', 'home')
    const wslLinuxHomePath = '/home/alice/.local/share/orca/codex-accounts/account-1/home'
    mkdirSync(wslManagedHomePath, { recursive: true })
    writeFileSync(join(wslManagedHomePath, '.orca-managed-home'), 'account-1\n', 'utf-8')
    writeFileSync(
      join(wslManagedHomePath, 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: `header.${Buffer.from(JSON.stringify({ email: 'old@example.com' })).toString(
            'base64url'
          )}.signature`
        }
      }),
      'utf-8'
    )

    const execFileSyncMock = vi.fn((_command: string, args: string[]) => {
      const script = decodeEncodedWslBashCommand(String(args.at(-1)))
      if (script.includes('readlink -f')) {
        return `${wslLinuxHomePath}\n`
      }
      return ''
    })
    const runWslProcessMock = vi.fn(async () => wslOk())
    let clearSelectionDuringLogin = (): void => {}
    const spawnMock = vi.fn((command: string, args: string[]) => {
      expect(command).toBe('wsl.exe')
      expect(args).toEqual(buildWslCodexLoginArgs('Ubuntu', wslLinuxHomePath))
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
        kill: () => void
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = vi.fn()
      clearSelectionDuringLogin()
      writeFileSync(
        join(wslManagedHomePath, 'auth.json'),
        JSON.stringify({
          tokens: {
            id_token: `header.${Buffer.from(JSON.stringify({ email: 'new@example.com' })).toString(
              'base64url'
            )}.signature`
          }
        }),
        'utf-8'
      )
      queueMicrotask(() => child.emit('close', 0))
      return child
    })

    vi.doMock('node:child_process', () => ({
      execFileSync: execFileSyncMock,
      spawn: spawnMock
    }))
    vi.doMock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))
    vi.doMock('../../shared/wsl-paths', () => ({
      parseWslUncPath: (path: string) =>
        path === wslManagedHomePath ? { distro: 'Ubuntu', linuxPath: wslLinuxHomePath } : null
    }))
    vi.doMock('../wsl', () => ({
      toWindowsWslPath: () => wslManagedHomePath
    }))

    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'old@example.com',
          managedHomePath: wslManagedHomePath,
          managedHomeRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: null,
      activeCodexManagedAccountIdsByRuntime: {
        host: null,
        wsl: { Ubuntu: 'account-1' }
      }
    })
    const store = createStore(settings)
    clearSelectionDuringLogin = () => {
      const current = store.getSettings()
      store.updateSettings({
        activeCodexManagedAccountIdsByRuntime: {
          ...current.activeCodexManagedAccountIdsByRuntime!,
          wsl: { Ubuntu: null }
        }
      })
    }
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    try {
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      const result = await service.reauthenticateAccount('account-1')

      expect(result.accounts[0]).toMatchObject({
        email: 'new@example.com',
        managedHomeRuntime: 'wsl',
        wslDistro: 'Ubuntu'
      })
      expect(result.activeAccountId).toBe(null)
      expect(result.activeAccountIdsByRuntime).toEqual({
        host: null,
        wsl: { Ubuntu: 'account-1' }
      })
      expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalledWith({
        runtime: 'wsl',
        wslDistro: 'Ubuntu'
      })
      expect(rateLimits.refreshForCodexAccountChange).toHaveBeenCalledWith(undefined, {
        runtime: 'wsl',
        wslDistro: 'Ubuntu'
      })
      expect(store.updateSettings).toHaveBeenCalledTimes(2)
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('recreates the expected missing WSL managed home before reauthenticating', async () => {
    vi.resetModules()
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    const wslManagedHomePath = join(testState.userDataDir, 'wsl-account', 'home')
    const wslLinuxHomePath = '/home/alice/.local/share/orca/codex-accounts/account-1/home'

    const execFileSyncMock = vi.fn((_command: string, args: string[]) => {
      const script = decodeEncodedWslBashCommand(String(args.at(-1)))
      if (script.includes('readlink -f')) {
        return `${wslLinuxHomePath}\n`
      }
      return ''
    })
    const runWslProcessMock = vi.fn(async (spec: WslSpec) => {
      const script = String(spec.script)
      if (script.includes('mkdir -p -- "$candidate"')) {
        expect(spec.shell).toBe('bash')
        mkdirSync(wslManagedHomePath, { recursive: true })
        writeFileSync(join(wslManagedHomePath, '.orca-managed-home'), 'account-1\n', 'utf-8')
      }
      return wslOk()
    })
    const spawnMock = vi.fn((command: string, args: string[]) => {
      expect(command).toBe('wsl.exe')
      expect(args).toEqual(buildWslCodexLoginArgs('Ubuntu', wslLinuxHomePath))
      expect(readFileSync(join(wslManagedHomePath, '.orca-managed-home'), 'utf-8')).toBe(
        'account-1\n'
      )
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
        kill: () => void
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = vi.fn()
      writeFileSync(
        join(wslManagedHomePath, 'auth.json'),
        createCodexAuthJson('new-wsl@example.com', 'provider-wsl-1', 'refresh-token'),
        'utf-8'
      )
      queueMicrotask(() => child.emit('close', 0))
      return child
    })

    vi.doMock('node:child_process', () => ({
      execFileSync: execFileSyncMock,
      spawn: spawnMock
    }))
    vi.doMock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))
    vi.doMock('../../shared/wsl-paths', () => ({
      parseWslUncPath: (path: string) =>
        path === wslManagedHomePath ? { distro: 'Ubuntu', linuxPath: wslLinuxHomePath } : null
    }))
    vi.doMock('../wsl', () => ({
      toWindowsWslPath: () => wslManagedHomePath
    }))

    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'old-wsl@example.com',
          managedHomePath: wslManagedHomePath,
          managedHomeRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      const result = await service.reauthenticateAccount('account-1')

      expect(result.accounts[0]).toMatchObject({
        email: 'new-wsl@example.com',
        providerAccountId: 'provider-wsl-1',
        managedHomeRuntime: 'wsl',
        wslDistro: 'Ubuntu'
      })
      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('removes a WSL managed account only after canonical path validation', async () => {
    vi.resetModules()
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    const wslManagedHomePath = join(testState.userDataDir, 'wsl-account', 'home')
    const wslLinuxHomePath = '/home/alice/.local/share/orca/codex-accounts/account-1/home'
    mkdirSync(wslManagedHomePath, { recursive: true })
    writeFileSync(join(wslManagedHomePath, '.orca-managed-home'), 'account-1\n', 'utf-8')

    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn((_command: string, args: string[]) => {
        const script = decodeEncodedWslBashCommand(String(args.at(-1)))
        if (script.includes('readlink -f')) {
          expect(script).toContain("expected_marker='account-1'")
          expect(script).toContain(
            'test "$candidate_real" = "$managed_root_real/$expected_marker/home"'
          )
          expect(script).toContain(
            'test "$(cat "$candidate_real/.orca-managed-home")" = "$expected_marker"'
          )
          return `${wslLinuxHomePath}\n`
        }
        return ''
      }),
      spawn: vi.fn()
    }))
    vi.doMock('../wsl/wsl-runner', () => ({ runWslProcess: vi.fn(async () => wslOk()) }))
    vi.doMock('../../shared/wsl-paths', () => ({
      parseWslUncPath: (path: string) =>
        path === wslManagedHomePath ? { distro: 'Ubuntu', linuxPath: wslLinuxHomePath } : null
    }))
    vi.doMock('../wsl', () => ({
      toWindowsWslPath: () => wslManagedHomePath
    }))

    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'wsl@example.com',
          managedHomePath: wslManagedHomePath,
          managedHomeRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1'
    })
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const runtimeHome = createRuntimeHome()

    try {
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        store as never,
        rateLimits as never,
        runtimeHome as never
      )

      const result = await service.removeAccount('account-1')

      expect(result.accounts).toHaveLength(0)
      expect(existsSync(wslManagedHomePath)).toBe(false)
      expect(existsSync(join(testState.userDataDir, 'wsl-account'))).toBe(false)
      expect(rateLimits.evictInactiveCodexCache).toHaveBeenCalledWith('account-1')
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })
})
