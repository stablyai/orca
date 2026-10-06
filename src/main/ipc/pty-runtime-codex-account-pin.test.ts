import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { readFileSyncMock, recordCodexPaneAccountMock } from './pty-ipc-mock-registry'
import { TEST_CODEX_AUTH_JSON, TEST_MANAGED_ROOT } from './pty-ipc-test-constants'
import { registerPtyHandlers } from './pty'
import type { RuntimePtyController } from '../runtime/runtime-pty-controller-contract'
import type { GetSelectedCodexHomePath } from './pty/host-env/types'
import type { PtySpawnOptions } from '../providers/types'
import { createSettings } from '../codex-accounts/runtime-home-settings-test-fixtures'
import { createCodexAccountRecord } from '../codex-accounts/runtime-home-service-test-harness'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'

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

const homeA = join(TEST_MANAGED_ROOT, 'account-a', 'home')
const homeB = join(TEST_MANAGED_ROOT, 'account-b', 'home')
const systemHome = getSystemCodexHomePath()

describe('native runtime Codex account pins', () => {
  const { mainWindow, handlers, installDaemonTestProvider } = setupPtyIpcSuite()

  function fixture(resolveHome?: GetSelectedCodexHomePath) {
    readFileSyncMock.mockImplementation((path: string) =>
      path.endsWith('auth.json') ? TEST_CODEX_AUTH_JSON : ''
    )
    const settings = createSettings({
      activeCodexManagedAccountId: 'account-a',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-a', wsl: {} },
      codexManagedAccounts: [
        createCodexAccountRecord('account-a', 'a@example.com', 'provider-a', homeA),
        createCodexAccountRecord('account-b', 'b@example.com', 'provider-b', homeB)
      ]
    })
    const prepareHome = vi.fn<GetSelectedCodexHomePath>(
      resolveHome ??
        ((_target, _env, context) => {
          return context?.pinnedAccountId === null
            ? systemHome
            : context?.pinnedAccountId === 'account-b'
              ? homeB
              : homeA
        })
    )
    let controller: RuntimePtyController | undefined
    const runtime = {
      setPtyController: (next: RuntimePtyController) => {
        controller = next
      },
      registerPty: vi.fn()
    }
    const spawn = installDaemonTestProvider()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies only the runtime/window members the native controller reads; no Electron window is created.
    registerPtyHandlers(mainWindow as never, runtime as never, prepareHome, () => settings)
    if (!controller?.spawn) {
      throw new Error('native spawn controller missing')
    }
    return { spawn: controller.spawn, providerSpawn: spawn, prepareHome, settings }
  }

  it('launches A and B concurrently with isolated environments and attribution while preserving another session', async () => {
    const { spawn, providerSpawn, prepareHome, settings } = fixture()
    const environments = new Map<string, Record<string, string>>()
    providerSpawn.mockImplementation(async (options: PtySpawnOptions) => {
      const id = options.sessionId ?? 'fixture-pty'
      environments.set(id, { ...options.env })
      return { id }
    })
    const existing = await spawn({ cols: 80, rows: 24, launchAgent: 'codex', command: 'codex' })
    const existingEnv = structuredClone(environments.get(existing.id))
    const initialSettings = structuredClone(settings)
    prepareHome.mockClear()
    const [a, b] = await Promise.all([
      spawn({
        cols: 80,
        rows: 24,
        launchAgent: 'codex',
        command: 'codex',
        codexAccountId: 'account-a'
      }),
      spawn({
        cols: 80,
        rows: 24,
        launchAgent: 'codex',
        command: 'codex',
        codexAccountId: 'account-b'
      })
    ])
    expect(environments.get(a.id)).toMatchObject({ CODEX_HOME: homeA, ORCA_CODEX_HOME: homeA })
    expect(environments.get(b.id)).toMatchObject({ CODEX_HOME: homeB, ORCA_CODEX_HOME: homeB })
    expect(environments.get(existing.id)).toEqual(existingEnv)
    expect(settings).toEqual(initialSettings)
    expect(prepareHome).toHaveBeenCalledTimes(2)
    expect(recordCodexPaneAccountMock).toHaveBeenCalledWith(a.id, {
      selectionKey: 'host',
      accountId: 'account-a',
      homeRoute: 'account-home',
      pinned: true
    })
    expect(recordCodexPaneAccountMock).toHaveBeenCalledWith(b.id, {
      selectionKey: 'host',
      accountId: 'account-b',
      homeRoute: 'account-home',
      pinned: true
    })
    expect(recordCodexPaneAccountMock).toHaveBeenCalledWith(existing.id, {
      selectionKey: 'host',
      accountId: 'account-a',
      homeRoute: 'account-home'
    })
  })

  it('overrides inherited home for explicit system despite the global managed account', async () => {
    const { spawn, providerSpawn, settings } = fixture()
    await spawn({
      cols: 80,
      rows: 24,
      launchAgent: 'codex',
      codexAccountId: null,
      env: { CODEX_HOME: homeA, ORCA_CODEX_HOME: homeA },
      envToDelete: ['CODEX_HOME']
    })
    expect(providerSpawn.mock.calls[0][0].env).toMatchObject({
      CODEX_HOME: systemHome,
      ORCA_CODEX_HOME: systemHome
    })
    expect(providerSpawn.mock.calls[0][0].envToDelete ?? []).not.toContain('CODEX_HOME')
    expect(settings.activeCodexManagedAccountId).toBe('account-a')
    expect(recordCodexPaneAccountMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ accountId: null, pinned: true })
    )
  })

  it('leaves the resolver call signature unchanged when omitted', async () => {
    const { spawn, prepareHome } = fixture()
    await spawn({ cols: 80, rows: 24, launchAgent: 'codex' })
    expect(prepareHome.mock.calls[0]).toHaveLength(2)
  })

  it.each([
    { sessionId: 'existing' },
    { connectionId: 'ssh-host' },
    { launchAgent: 'claude' as const },
    { shellOverride: 'wsl.exe', cwd: '\\\\wsl$\\Ubuntu\\home\\fixture' }
  ])(
    'refuses unsupported low-level placements %j before home preparation or spawn',
    async (placement) => {
      const { spawn, providerSpawn, prepareHome } = fixture()
      await expect(
        spawn({
          cols: 80,
          rows: 24,
          launchAgent: 'codex',
          codexAccountId: 'account-b',
          ...placement
        })
      ).rejects.toThrow('--account')
      expect(providerSpawn).not.toHaveBeenCalled()
      expect(prepareHome).not.toHaveBeenCalled()
    }
  )

  it('refuses missing pin support rather than launching the active account', async () => {
    const { spawn, providerSpawn } = fixture(() => null)
    await expect(
      spawn({ cols: 80, rows: 24, launchAgent: 'codex', codexAccountId: 'account-b' })
    ).rejects.toThrow('could not prepare')
    expect(providerSpawn).not.toHaveBeenCalled()
  })

  it('refuses a legacy callback that ignores the pin and returns the global active home', async () => {
    const { spawn, providerSpawn } = fixture(() => homeA)
    await expect(
      spawn({ cols: 80, rows: 24, launchAgent: 'codex', codexAccountId: 'account-b' })
    ).rejects.toThrow('could not prepare')
    await expect(
      spawn({ cols: 80, rows: 24, launchAgent: 'codex', codexAccountId: null })
    ).rejects.toThrow('could not prepare')
    expect(providerSpawn).not.toHaveBeenCalled()
  })

  it('refuses unavailable pinned credentials without resolving the global selection or falling back', async () => {
    vi.useFakeTimers()
    const { spawn, providerSpawn, prepareHome, settings } = fixture()
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('fixture missing auth'), { code: 'ENOENT' })
    })
    const attempt = spawn({ cols: 80, rows: 24, launchAgent: 'codex', codexAccountId: 'account-b' })
    const refused = expect(attempt).rejects.toThrow('credentials for this session')
    await vi.runAllTimersAsync()
    await refused
    expect(prepareHome).toHaveBeenCalledTimes(1)
    expect(prepareHome.mock.calls[0][2]).toEqual({ pinnedAccountId: 'account-b' })
    expect(settings.activeCodexManagedAccountId).toBe('account-a')
    expect(providerSpawn).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('refuses renderer-driven attempts to pass an account pin', async () => {
    const { providerSpawn } = fixture()
    await expect(
      handlers.get('pty:spawn')?.(null, {
        cols: 80,
        rows: 24,
        launchAgent: 'codex',
        codexAccountId: 'account-b'
      })
    ).rejects.toThrow('native runtime terminal')
    expect(providerSpawn).not.toHaveBeenCalled()
  })
})
