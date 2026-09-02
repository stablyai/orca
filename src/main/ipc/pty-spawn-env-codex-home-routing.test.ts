import { describe, expect, it, vi } from 'vitest'
import {
  readFileSyncMock,
  spawnMock,
  buildAgentHookEnvMock,
  piBuildPtyEnvMock,
  ensureCodexBackfillRecoveryMock
} from './pty-ipc-mock-registry'
import { posixOnlyIt, TEST_CODEX_HOME, TEST_CODEX_AUTH_JSON } from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './pty'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('registerPtyHandlers', () => {
  const { handlers, mainWindow, spawnAndGetEnv } = setupPtyIpcSuite()

  describe('spawn environment', () => {
    it('does not use an inherited Pi overlay source for an OMP launch', async () => {
      const env = await spawnAndGetEnv(
        {
          PI_CODING_AGENT_DIR: '/tmp/parent-orca-pi-overlay',
          ORCA_PI_CODING_AGENT_DIR: '/tmp/parent-orca-pi-overlay',
          ORCA_PI_SOURCE_AGENT_DIR: '/tmp/user-pi-agent'
        },
        undefined,
        undefined,
        undefined,
        'omp'
      )

      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), undefined, 'omp', {
        materializeDefaultHome: true
      })
      expect(env.ORCA_OMP_CODING_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_OMP_SOURCE_AGENT_DIR).toBe('/tmp/default-omp-agent')
      expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBeUndefined()
    })
    it('does not use an inherited OMP overlay source for an explicit Pi launch', async () => {
      const env = await spawnAndGetEnv(
        {
          PI_CODING_AGENT_DIR: '/tmp/parent-orca-omp-overlay',
          ORCA_OMP_CODING_AGENT_DIR: '/tmp/parent-orca-omp-overlay',
          ORCA_OMP_SOURCE_AGENT_DIR: '/tmp/user-omp-agent'
        },
        undefined,
        undefined,
        undefined,
        'pi'
      )

      expect(piBuildPtyEnvMock).toHaveBeenCalledWith(expect.any(String), undefined, 'pi', {
        materializeDefaultHome: true
      })
      expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBe('/tmp/default-pi-agent')
      expect(env.ORCA_OMP_CODING_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_OMP_SOURCE_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_OMP_STATUS_EXTENSION).toBeUndefined()
    })
    it('restores user Pi config when agent status hooks are disabled in a nested Orca shell', async () => {
      const env = await spawnAndGetEnv(
        {
          PI_CODING_AGENT_DIR: '/tmp/parent-orca-pi-overlay',
          ORCA_PI_CODING_AGENT_DIR: '/tmp/parent-orca-pi-overlay',
          ORCA_PI_SOURCE_AGENT_DIR: '/tmp/user-pi-agent'
        },
        undefined,
        undefined,
        () => ({ agentStatusHooksEnabled: false })
      )

      expect(piBuildPtyEnvMock).not.toHaveBeenCalled()
      expect(env.PI_CODING_AGENT_DIR).toBe('/tmp/user-pi-agent')
      expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBeUndefined()
    })
    it('strips only the Prime source shadow when hooks are disabled', async () => {
      const env = await spawnAndGetEnv(
        {
          PRIME_AGENT_CODING_AGENT_DIR: '/tmp/user-prime-agent',
          ORCA_PRIME_AGENT_SOURCE_AGENT_DIR: '/tmp/user-prime-agent'
        },
        undefined,
        undefined,
        () => ({ agentStatusHooksEnabled: false })
      )

      expect(env.PRIME_AGENT_CODING_AGENT_DIR).toBe('/tmp/user-prime-agent')
      expect(env.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR).toBeUndefined()
    })
    posixOnlyIt(
      'uses Pi config exported only by shell startup files as the managed extension target',
      async () => {
        readFileSyncMock.mockImplementation((path: string) =>
          path.endsWith('.zshrc') ? 'export PI_CODING_AGENT_DIR="$HOME/.config/pi-agent"\n' : ''
        )

        const env = await spawnAndGetEnv(undefined, {
          HOME: '/home/tester',
          SHELL: '/bin/zsh',
          PI_CODING_AGENT_DIR: undefined
        })

        expect(piBuildPtyEnvMock).toHaveBeenCalledWith(
          expect.any(String),
          '/home/tester/.config/pi-agent',
          'pi',
          { materializeDefaultHome: false }
        )
        expect(env.PI_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_PI_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBe('/home/tester/.config/pi-agent')
      }
    )
    it('injects the agent hook receiver env into Orca terminal PTYs', async () => {
      const env = await spawnAndGetEnv()
      // Why: buildAgentHookEnv must run exactly once per local spawn (inside shared buildPtyHostEnv); the old ad-hoc double-call is gone.
      expect(buildAgentHookEnvMock).toHaveBeenCalledTimes(1)
      expect(env.ORCA_AGENT_HOOK_PORT).toBe('5678')
      expect(env.ORCA_AGENT_HOOK_TOKEN).toBe('agent-token')
    })
    it('strips stale inherited hook receiver env before injecting this runtime', async () => {
      const env = await spawnAndGetEnv({
        ORCA_AGENT_HOOK_PORT: '1111',
        ORCA_AGENT_HOOK_TOKEN: 'stale-token',
        ORCA_AGENT_HOOK_ENV: 'production',
        ORCA_AGENT_HOOK_VERSION: 'stale-version',
        ORCA_AGENT_HOOK_ENDPOINT: '/tmp/stale-endpoint.env',
        ORCA_CLAUDE_AGENT_STATUS_SETTINGS: '/tmp/orca/agent-hooks/claude-agent-status-settings.json'
      })

      expect(env.ORCA_AGENT_HOOK_PORT).toBe('5678')
      expect(env.ORCA_AGENT_HOOK_TOKEN).toBe('agent-token')
      expect(env.ORCA_AGENT_HOOK_ENV).toBeUndefined()
      expect(env.ORCA_AGENT_HOOK_VERSION).toBeUndefined()
      expect(env.ORCA_AGENT_HOOK_ENDPOINT).toBeUndefined()
      expect(env.ORCA_CLAUDE_AGENT_STATUS_SETTINGS).toBeUndefined()
    })
    it('does not leak inherited hook receiver env if the hook server is unavailable', async () => {
      buildAgentHookEnvMock.mockReturnValueOnce({})

      const env = await spawnAndGetEnv({
        ORCA_AGENT_HOOK_PORT: '1111',
        ORCA_AGENT_HOOK_TOKEN: 'stale-token',
        ORCA_AGENT_HOOK_ENV: 'production',
        ORCA_AGENT_HOOK_VERSION: 'stale-version',
        ORCA_AGENT_HOOK_ENDPOINT: '/tmp/stale-endpoint.env',
        ORCA_CLAUDE_AGENT_STATUS_SETTINGS: '/tmp/orca/agent-hooks/claude-agent-status-settings.json'
      })

      expect(env.ORCA_AGENT_HOOK_PORT).toBeUndefined()
      expect(env.ORCA_AGENT_HOOK_TOKEN).toBeUndefined()
      expect(env.ORCA_AGENT_HOOK_ENV).toBeUndefined()
      expect(env.ORCA_AGENT_HOOK_VERSION).toBeUndefined()
      expect(env.ORCA_AGENT_HOOK_ENDPOINT).toBeUndefined()
      expect(env.ORCA_CLAUDE_AGENT_STATUS_SETTINGS).toBeUndefined()
    })
    it('overrides ambient CODEX_HOME with the Orca-managed home for system default', async () => {
      const env = await spawnAndGetEnv(
        undefined,
        { CODEX_HOME: '/tmp/system-codex-home' },
        () => TEST_CODEX_HOME
      )
      expect(env.CODEX_HOME).toBe(TEST_CODEX_HOME)
      expect(env.ORCA_CODEX_HOME).toBe(TEST_CODEX_HOME)
    })
    it('waits for managed Codex auth before spawning a local PTY', async () => {
      vi.useFakeTimers()
      let authReady = false
      readFileSyncMock.mockImplementation((filePath: string) => {
        if (!filePath.endsWith('auth.json')) {
          return ''
        }
        if (!authReady) {
          throw Object.assign(new Error('missing auth'), { code: 'ENOENT' })
        }
        return TEST_CODEX_AUTH_JSON
      })
      handlers.clear()
      registerPtyHandlers(mainWindow as never, undefined, () => TEST_CODEX_HOME, (() => ({
        codexManagedAccounts: [
          {
            id: 'account-1',
            managedHomePath: TEST_CODEX_HOME,
            managedHomeRuntime: 'host'
          }
        ]
      })) as never)

      const spawnPromise = handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        launchAgent: 'codex'
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(spawnMock).not.toHaveBeenCalled()

      authReady = true
      await vi.advanceTimersByTimeAsync(25)
      await spawnPromise

      expect(spawnMock.mock.calls.at(-1)?.[2].env).toMatchObject({
        CODEX_HOME: TEST_CODEX_HOME,
        ORCA_CODEX_HOME: TEST_CODEX_HOME
      })
    })
    it('arbitrates the exact backfill owner before spawning Codex', async () => {
      let releaseRecovery!: () => void
      ensureCodexBackfillRecoveryMock.mockReturnValue(
        new Promise<void>((resolve) => (releaseRecovery = resolve))
      )
      readFileSyncMock.mockReturnValue(TEST_CODEX_AUTH_JSON)
      const onCodexHomePtySpawned = vi.fn()
      handlers.clear()
      registerPtyHandlers(
        mainWindow as never,
        undefined,
        () => TEST_CODEX_HOME,
        (() => ({
          codexManagedAccounts: [
            {
              id: 'account-1',
              managedHomePath: TEST_CODEX_HOME,
              managedHomeRuntime: 'host'
            }
          ]
        })) as never,
        undefined,
        undefined,
        { onCodexHomePtySpawned }
      )

      const spawnPromise = handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        launchAgent: 'codex'
      })
      await vi.waitFor(() =>
        expect(ensureCodexBackfillRecoveryMock).toHaveBeenCalledWith(TEST_CODEX_HOME)
      )
      expect(spawnMock).not.toHaveBeenCalled()
      expect(onCodexHomePtySpawned).not.toHaveBeenCalled()

      releaseRecovery()
      const result = (await spawnPromise) as { id: string }
      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(onCodexHomePtySpawned).toHaveBeenCalledWith({
        id: result.id,
        codexHomePath: TEST_CODEX_HOME,
        startedAt: expect.any(Date),
        startedSequence: expect.any(Number)
      })
    })
    it('does not gate a bare local shell on managed Codex auth', async () => {
      readFileSyncMock.mockImplementation((filePath: string) => {
        if (filePath.endsWith('auth.json')) {
          throw Object.assign(new Error('missing auth'), { code: 'ENOENT' })
        }
        return ''
      })
      handlers.clear()
      const onCodexHomePtySpawned = vi.fn()
      registerPtyHandlers(
        mainWindow as never,
        undefined,
        () => TEST_CODEX_HOME,
        (() => ({
          codexManagedAccounts: [
            {
              id: 'account-1',
              managedHomePath: TEST_CODEX_HOME,
              managedHomeRuntime: 'host'
            }
          ]
        })) as never,
        undefined,
        undefined,
        { onCodexHomePtySpawned }
      )

      const result = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24
      })) as { id: string }

      expect(spawnMock).toHaveBeenCalledOnce()
      expect(onCodexHomePtySpawned).toHaveBeenCalledWith({
        id: result.id,
        codexHomePath: TEST_CODEX_HOME,
        startedAt: expect.any(Date),
        startedSequence: expect.any(Number)
      })
    })
    it('leaves an inherited CODEX_HOME untouched for system default when the flag is OFF', async () => {
      // Why: flag OFF must stay byte-identical to today. With no managed home
      // selected (resolver null) and the real-home flag off, no CODEX_HOME
      // injection or strip happens; an inherited value survives as before.
      const env = await spawnAndGetEnv(
        undefined,
        { CODEX_HOME: '/tmp/system-codex-home' },
        () => null
      )
      expect(env.CODEX_HOME).toBe('/tmp/system-codex-home')
    })
    it('strips a nested-Orca override for system default when the real-home flag is ON', async () => {
      const env = await spawnAndGetEnv(
        { CODEX_HOME: '/managed/home', ORCA_CODEX_HOME: '/managed/home' },
        undefined,
        () => null,
        () => ({ codexSystemDefaultRealHomeEnabled: true }) as never
      )
      expect(env.CODEX_HOME).toBeUndefined()
      expect(env.ORCA_CODEX_HOME).toBeUndefined()
    })
    it('preserves a user-owned CODEX_HOME for system default when the real-home flag is ON', async () => {
      const env = await spawnAndGetEnv(
        { CODEX_HOME: '/home/me/.config/codex' },
        { ORCA_CODEX_HOME: undefined },
        () => null,
        () => ({ codexSystemDefaultRealHomeEnabled: true }) as never
      )
      expect(env.CODEX_HOME).toBe('/home/me/.config/codex')
      expect(env.ORCA_CODEX_HOME).toBeUndefined()
    })
    it('lets the resolver keep a per-spawn custom CODEX_HOME on the managed lane', async () => {
      const customHome = '/home/me/.config/codex'
      let resolvedCodexHome: string | undefined
      const resolveHome = vi.fn((_target: unknown, launchEnv?: NodeJS.ProcessEnv) => {
        resolvedCodexHome = launchEnv?.CODEX_HOME
        return launchEnv?.CODEX_HOME === customHome ? TEST_CODEX_HOME : null
      })

      const env = await spawnAndGetEnv(
        { CODEX_HOME: customHome },
        { CODEX_HOME: undefined, ORCA_CODEX_HOME: undefined },
        resolveHome,
        () => ({ codexSystemDefaultRealHomeEnabled: true }) as never
      )

      expect(resolveHome).toHaveBeenCalledTimes(1)
      expect(resolveHome.mock.calls[0]?.[0]).toEqual({ runtime: 'host' })
      expect(resolvedCodexHome).toBe(customHome)
      expect(env.CODEX_HOME).toBe(TEST_CODEX_HOME)
      expect(env.ORCA_CODEX_HOME).toBe(TEST_CODEX_HOME)
    })
    it('injects explicit proxy settings into local PTY env', async () => {
      const env = await spawnAndGetEnv(undefined, undefined, undefined, () => ({
        httpProxyUrl: 'http://proxy.example:8080',
        httpProxyBypassRules: 'localhost,*.internal'
      }))

      expect(env.HTTP_PROXY).toBe('http://proxy.example:8080')
      expect(env.HTTPS_PROXY).toBe('http://proxy.example:8080')
      expect(env.ALL_PROXY).toBe('http://proxy.example:8080')
      expect(env.NO_PROXY).toBe('localhost,*.internal')
    })
  })
})
