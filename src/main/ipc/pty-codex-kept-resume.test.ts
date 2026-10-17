import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { readFileSyncMock, recordCodexPaneAccountMock } from './pty-ipc-mock-registry'
import { TEST_CODEX_AUTH_JSON, TEST_MANAGED_ROOT } from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { installAgentRunAccounts } from '../agent-accounts/agent-run-accounts-installed'
import {
  fakeRuntime,
  installFakeLocalProvider,
  installKeptIndex,
  registerKeptAccountHandlers
} from './pty-kept-account-spawn.test-fixture'

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

const KEPT_HOME = join(TEST_MANAGED_ROOT, 'kept', 'home')
const SELECTED_HOME = join(TEST_MANAGED_ROOT, 'selected', 'home')
const ROLLOUT = join(KEPT_HOME, 'sessions', '2026', '10', '14', 'rollout-a.jsonl')

const SETTINGS = {
  activeCodexManagedAccountId: 'account-b',
  codexManagedAccounts: [
    { id: 'account-a', managedHomePath: KEPT_HOME },
    { id: 'account-b', managedHomePath: SELECTED_HOME }
  ],
  claudeManagedAccounts: []
}

const RESUME = {
  key: 'session_id' as const,
  id: 'session-a',
  transcriptPath: ROLLOUT
}

const KEPT_ON_A = { 'codex:session-a': { lane: 'host', accountId: 'account-a', keptAt: 1 } }

describe('a kept Codex conversation in both spawn paths', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()
  afterEach(() => installAgentRunAccounts(undefined))

  function register(runtime?: unknown) {
    const prepareCodexSessionResume = vi.fn(async (_args: Record<string, unknown>) => ({
      outcome: 'resume' as const,
      codexHomePath: KEPT_HOME
    }))
    handlers.clear()
    registerKeptAccountHandlers({
      mainWindow,
      runtime,
      settings: SETTINGS,
      getSelectedCodexHomePath: vi.fn(() => SELECTED_HOME),
      prepareCodexSessionResume
    })
    readFileSyncMock.mockReturnValue(TEST_CODEX_AUTH_JSON)
    return prepareCodexSessionResume
  }

  it('resumes on the kept account in the window path and keeps the pane', async () => {
    installKeptIndex(KEPT_ON_A)
    const spawn = installFakeLocalProvider('pty-kept')
    const prepare = register()

    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      command: 'codex resume session-a',
      launchAgent: 'codex',
      // A restart request would otherwise move it to the selection.
      replacesPtyId: 'pty-old',
      resumeProviderSession: RESUME
    })

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ keptAccount: { accountId: 'account-a' } })
    )
    expect(prepare.mock.calls[0]![0]).not.toHaveProperty('useSelectedAccount')
    expect(recordCodexPaneAccountMock.mock.calls).toEqual([
      [
        'pty-kept',
        { selectionKey: 'host', accountId: 'account-a', homeRoute: 'account-home', kept: true }
      ]
    ])
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('resumes on the kept account in the runtime path and keeps the pane', async () => {
    installKeptIndex(KEPT_ON_A)
    installFakeLocalProvider('pty-runtime-kept')
    const runtime = fakeRuntime()
    const prepare = register(runtime.runtime)

    await runtime.spawn({
      cols: 80,
      rows: 24,
      worktreeId: 'wt-runtime',
      command: 'codex resume session-a',
      launchAgent: 'codex',
      resumeProviderSession: RESUME
    })

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ keptAccount: { accountId: 'account-a' } })
    )
    expect(recordCodexPaneAccountMock.mock.calls).toEqual([
      [
        'pty-runtime-kept',
        { selectionKey: 'host', accountId: 'account-a', homeRoute: 'account-home', kept: true }
      ]
    ])
  })

  it('leaves a conversation nobody kept exactly as before', async () => {
    installKeptIndex({})
    installFakeLocalProvider('pty-follow')
    const prepare = register()

    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      command: 'codex resume session-a',
      launchAgent: 'codex',
      replacesPtyId: 'pty-old',
      resumeProviderSession: RESUME
    })

    expect(prepare.mock.calls[0]![0]).toEqual({
      providerSession: RESUME,
      target: { runtime: 'host' },
      launchEnv: undefined,
      useSelectedAccount: true
    })
    expect(recordCodexPaneAccountMock.mock.calls[0]![1]).not.toHaveProperty('kept')
  })

  it('refuses before spawning when the keep cannot be honoured', async () => {
    installKeptIndex({
      'codex:session-a': { lane: 'host', accountId: 'account-gone', keptAt: 1 }
    })
    const spawn = installFakeLocalProvider('pty-refused')
    register()

    await expect(
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        command: 'codex resume session-a',
        launchAgent: 'codex',
        resumeProviderSession: RESUME
      })
    ).rejects.toThrow(/no longer saved/)
    expect(spawn).not.toHaveBeenCalled()
  })
})
