import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type * as WslPaths from '../../shared/wsl-paths'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createManagedAuth,
  createStore,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

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

describe('CodexRuntimeHomeService', () => {
  beforeEach(() => {
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    teardownRuntimeHomeTest()
  })

  it('builds a valid WSL legacy active-home migration shell command', async () => {
    const execFileSyncMock = vi.fn()
    vi.doMock('node:child_process', () => ({ execFileSync: execFileSyncMock }))

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(
        createStore(createSettings()) as never
      ) as unknown as {
        migrateLegacyWslActiveHomePointer(distro: string, runtimeHomePath: string): void
      }

      service.migrateLegacyWslActiveHomePointer(
        'Ubuntu',
        '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\codex-runtime-home\\home'
      )

      expect(execFileSyncMock).toHaveBeenCalledTimes(1)
      const firstCall = execFileSyncMock.mock.calls[0]
      expect(firstCall).toBeDefined()
      const [command, args] = firstCall as [string, string[]]
      expect(command).toBe('wsl.exe')
      expect(args.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--exec', 'bash', '-lc'])
      expect(args).toHaveLength(6)

      const shellCommand = args[5]
      expect(shellCommand).toContain(
        "if [ ! -e '/home/alice/.local/share/orca/codex-runtime-home/active/wsl/home' ] && [ ! -L '/home/alice/.local/share/orca/codex-runtime-home/active/wsl/home' ]; then :"
      )
      expect(shellCommand).toContain(
        "elif [ -e '/home/alice/.local/share/orca/codex-runtime-home/active/wsl/home' ] && [ ! -L '/home/alice/.local/share/orca/codex-runtime-home/active/wsl/home' ]; then :"
      )
      expect(shellCommand).toContain(
        "mkdir -p '/home/alice/.local/share/orca/codex-runtime-home/active/wsl'"
      )
      expect(shellCommand).toContain(
        "ln -s -- '/home/alice/.local/share/orca/codex-runtime-home/home' '/home/alice/.local/share/orca/codex-runtime-home/active/wsl/home.next-"
      )
      expect(shellCommand).toContain(
        "mv -Tf -- '/home/alice/.local/share/orca/codex-runtime-home/active/wsl/home.next-"
      )
      expect(shellCommand).toContain(
        "' '/home/alice/.local/share/orca/codex-runtime-home/active/wsl/home'"
      )
      expect(shellCommand).not.toContain('[! -L')
      expect(shellCommand).not.toContain('mv -Tf--')
      expect(shellCommand).not.toContain('$1')
      expect(shellCommand).not.toContain('$2')
      expect(shellCommand).not.toContain('$3')
      expect(shellCommand).not.toContain('exit 0')
    } finally {
      vi.doUnmock('node:child_process')
    }
  })

  it('starts WSL session bridging after materializing the WSL launch home', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const startWslCodexSessionBridgeInBackground = vi.fn(() => Promise.resolve())
    vi.doMock('../codex/wsl-codex-session-bridge', () => ({
      startWslCodexSessionBridgeInBackground
    }))
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const wslSystemHomePath = join(wslHome, '.codex')
    mkdirSync(wslSystemHomePath, { recursive: true })
    writeFileSync(join(wslSystemHomePath, 'AGENTS.md'), '# WSL instructions\n', 'utf-8')
    const store = createStore(
      createSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      const wslRuntimeHomePath = join(
        wslHome,
        '.local',
        'share',
        'orca',
        'codex-runtime-home',
        'home'
      )

      expect(service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(
        wslRuntimeHomePath
      )
      expect(startWslCodexSessionBridgeInBackground).toHaveBeenCalledTimes(1)
      expect(startWslCodexSessionBridgeInBackground).toHaveBeenCalledWith({
        distro: 'Ubuntu',
        systemCodexHomePath: wslSystemHomePath,
        managedCodexHomePath: wslRuntimeHomePath
      })
      const runtimeAgentsPath = join(wslRuntimeHomePath, 'AGENTS.md')
      expect(readFileSync(runtimeAgentsPath, 'utf-8')).toBe('# WSL instructions\n')
      expect(lstatSync(runtimeAgentsPath).isSymbolicLink()).toBe(false)
    } finally {
      vi.doUnmock('../codex/wsl-codex-session-bridge')
      vi.doUnmock('../wsl')
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('promotes WSL in-Codex setting changes on the next Codex launch', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.doMock('../codex/wsl-codex-session-bridge', () => ({
      startWslCodexSessionBridgeInBackground: vi.fn(() => Promise.resolve())
    }))
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const store = createStore(
      createSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
      })
    )
    const wslSystemConfigPath = join(wslHome, '.codex', 'config.toml')
    mkdirSync(join(wslHome, '.codex'), { recursive: true })
    writeFileSync(wslSystemConfigPath, 'model = "gpt-5"\n', 'utf-8')

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      const wslRuntimeHomePath = join(
        wslHome,
        '.local',
        'share',
        'orca',
        'codex-runtime-home',
        'home'
      )

      // First launch seeds the runtime config and records the per-distro baseline.
      expect(service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(
        wslRuntimeHomePath
      )
      const baselinePath = join(wslRuntimeHomePath, '.orca-config-settings-baseline.json')
      expect(existsSync(baselinePath)).toBe(true)

      // A direct WSL Codex edit wins and is mirrored into Orca's runtime before
      // the baseline advances, so later in-Orca changes remain promotable.
      const runtimeConfigPath = join(wslRuntimeHomePath, 'config.toml')
      writeFileSync(wslSystemConfigPath, 'model = "outside-edit"\n', 'utf-8')
      service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })
      expect(readFileSync(runtimeConfigPath, 'utf-8')).toBe('model = "outside-edit"\n')
      expect(readFileSync(baselinePath, 'utf-8')).toContain('"model": "\\"outside-edit\\""')

      // Codex now persists a /model change inside Orca's reconciled runtime.
      writeFileSync(
        runtimeConfigPath,
        readFileSync(runtimeConfigPath, 'utf-8').replace('model = "outside-edit"', 'model = "o4"'),
        'utf-8'
      )

      service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })
      expect(readFileSync(wslSystemConfigPath, 'utf-8')).toBe('model = "o4"\n')
      // Baseline advances so the promoted value is not re-promoted forever.
      expect(readFileSync(baselinePath, 'utf-8')).toContain('"model": "\\"o4\\""')
    } finally {
      vi.doUnmock('../codex/wsl-codex-session-bridge')
      vi.doUnmock('../wsl')
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('bridges WSL history from a configured per-distro source-home override', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const startWslCodexSessionBridgeInBackground = vi.fn(() => Promise.resolve())
    vi.doMock('../codex/wsl-codex-session-bridge', () => ({
      startWslCodexSessionBridgeInBackground
    }))
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const store = createStore(
      createSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } },
        // Why: the override is a Linux path inside the distro, not <wslHome>/.codex.
        codexSessionSourceHome: { wsl: { Ubuntu: '/home/me/.config/codex' } }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      const wslRuntimeHomePath = join(
        wslHome,
        '.local',
        'share',
        'orca',
        'codex-runtime-home',
        'home'
      )

      service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })

      expect(startWslCodexSessionBridgeInBackground).toHaveBeenCalledTimes(1)
      expect(startWslCodexSessionBridgeInBackground).toHaveBeenCalledWith({
        distro: 'Ubuntu',
        systemCodexHomePath: '/home/me/.config/codex',
        managedCodexHomePath: wslRuntimeHomePath
      })
    } finally {
      vi.doUnmock('../codex/wsl-codex-session-bridge')
      vi.doUnmock('../wsl')
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('starts WSL session bridging for the distro used by the materialized runtime home', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const startWslCodexSessionBridgeInBackground = vi.fn(() => Promise.resolve())
    vi.doMock('../codex/wsl-codex-session-bridge', () => ({
      startWslCodexSessionBridgeInBackground
    }))
    const wslHome = join(testState.userDataDir, 'debian-wsl-home')
    const wslRuntimeHomePath = join(
      wslHome,
      '.local',
      'share',
      'orca',
      'codex-runtime-home',
      'home'
    )
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => null,
      getWslHome: (distro: string) => (distro === 'Debian' ? wslHome : null)
    }))
    vi.doMock('../../shared/wsl-paths', async (importOriginal) => {
      const actual = await importOriginal<typeof WslPaths>()
      return {
        ...actual,
        parseWslUncPath: (candidate: string) =>
          candidate === wslRuntimeHomePath
            ? {
                distro: 'Debian',
                linuxPath: '/home/alice/.local/share/orca/codex-runtime-home/home'
              }
            : null
      }
    })
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'debian-account',
      '{"account":"debian"}\n'
    )
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'debian-account',
            email: 'debian@example.com',
            managedHomePath,
            managedHomeRuntime: 'wsl',
            wslDistro: 'Debian',
            wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/debian/home',
            providerAccountId: null,
            workspaceLabel: null,
            workspaceAccountId: null,
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Debian: 'debian-account' } }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)

      expect(service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: null })).toBe(
        wslRuntimeHomePath
      )
      expect(startWslCodexSessionBridgeInBackground).toHaveBeenCalledWith({
        distro: 'Debian',
        systemCodexHomePath: join(wslHome, '.codex'),
        managedCodexHomePath: wslRuntimeHomePath
      })
    } finally {
      vi.doUnmock('../codex/wsl-codex-session-bridge')
      vi.doUnmock('../wsl')
      vi.doUnmock('../../shared/wsl-paths')
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })
})
