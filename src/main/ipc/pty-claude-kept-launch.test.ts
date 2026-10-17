import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { installAgentRunAccounts } from '../agent-accounts/agent-run-accounts-installed'
import {
  fakeRuntime,
  installFakeLocalProvider,
  installKeptIndex,
  registerKeptAccountHandlers
} from './pty-kept-account-spawn.test-fixture'
import {
  prepareInstalledClaudeLaunchForAccount,
  withClaudeKeptAccountTerminalEnv
} from '../claude-accounts/claude-profile-account-route'
import { withClaudeProfileTerminalEnv } from '../claude-accounts/claude-profile-installed-router'

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

// Why: the route's own behaviour has its own suite; here only which route a spawn takes matters.
vi.mock('../claude-accounts/claude-profile-account-route', () => ({
  withClaudeKeptAccountTerminalEnv: vi.fn(
    (env: Record<string, string> | undefined, accountId: string | null) => ({
      ...env,
      ORCA_CLAUDE_PROFILE_POINTER: `/data/claude-profile-pointers/account-${accountId}`
    })
  ),
  prepareInstalledClaudeLaunchForAccount: vi.fn(async (accountId: string | null) => ({
    configDir: `/data/claude-profiles/${accountId}/home`,
    envPatch: {
      ORCA_CLAUDE_PROFILE_POINTER: `/data/claude-profile-pointers/account-${accountId}`,
      CLAUDE_CONFIG_DIR: `/data/claude-profiles/${accountId}/home`,
      ORCA_CLAUDE_INJECTED_CONFIG_DIR: `/data/claude-profiles/${accountId}/home`
    },
    provenance: `profile:${accountId}`
  }))
}))
vi.mock('../claude-accounts/claude-profile-installed-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withClaudeProfileTerminalEnv: vi.fn((env: Record<string, string> | undefined) => ({
    ...env,
    ORCA_CLAUDE_PROFILE_POINTER: '/data/claude-profiles/selected-host'
  }))
}))

const RESUME = { key: 'session_id' as const, id: 's1' }
const TAB_ID = '55555555-5555-4555-8555-555555555555'
const LEAF_ID = '66666666-6666-4666-8666-666666666666'
const SETTINGS = {
  activeClaudeManagedAccountId: 'account-b',
  claudeManagedAccounts: [{ id: 'account-a' }, { id: 'account-b' }],
  codexManagedAccounts: []
}
const SELECTED_AUTH = {
  configDir: '/data/claude-profiles/account-b/home',
  envPatch: { ORCA_CLAUDE_PROFILE_POINTER: '/data/claude-profiles/selected-host' },
  provenance: 'profile:account-b'
}

describe('a Claude resume in both spawn paths', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()
  afterEach(() => {
    installAgentRunAccounts(undefined)
    vi.mocked(withClaudeKeptAccountTerminalEnv).mockClear()
    vi.mocked(prepareInstalledClaudeLaunchForAccount).mockClear()
    vi.mocked(withClaudeProfileTerminalEnv).mockClear()
  })

  const lanes = {
    window: async (prepareClaudeAuth: unknown) => {
      handlers.clear()
      registerKeptAccountHandlers({ mainWindow, settings: SETTINGS, prepareClaudeAuth })
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        command: 'claude --resume s1',
        launchAgent: 'claude',
        tabId: TAB_ID,
        leafId: LEAF_ID,
        env: { KEEP: 'me' },
        resumeProviderSession: RESUME
      })
    },
    host: async (prepareClaudeAuth: unknown) => {
      const runtime = fakeRuntime()
      handlers.clear()
      registerKeptAccountHandlers({
        mainWindow,
        runtime: runtime.runtime,
        settings: SETTINGS,
        prepareClaudeAuth
      })
      await runtime.spawn({
        cols: 80,
        rows: 24,
        worktreeId: 'wt-runtime',
        command: 'claude --resume s1',
        launchAgent: 'claude',
        env: { KEEP: 'me', ORCA_PANE_KEY: `${TAB_ID}:${LEAF_ID}` },
        resumeProviderSession: RESUME
      })
    }
  }

  it.each(['window', 'host'] as const)(
    'starts a kept conversation on its own account pointer: %s lane',
    async (lane) => {
      const notePaneLaunch = installKeptIndex({
        'claude:s1': { lane: 'host', accountId: 'account-a', keptAt: 1 }
      })
      const spawn = installFakeLocalProvider('pty-claude')
      const prepareClaudeAuth = vi.fn(async () => SELECTED_AUTH)

      await lanes[lane](prepareClaudeAuth)

      const env = spawn.mock.calls[0]![0].env ?? {}
      expect(env.ORCA_CLAUDE_PROFILE_POINTER).toBe(
        '/data/claude-profile-pointers/account-account-a'
      )
      expect(env.CLAUDE_CONFIG_DIR).toBe('/data/claude-profiles/account-a/home')
      expect(env.KEEP).toBe('me')
      expect(prepareInstalledClaudeLaunchForAccount).toHaveBeenCalledWith('account-a')
      expect(prepareClaudeAuth).not.toHaveBeenCalled()
      expect(withClaudeProfileTerminalEnv).not.toHaveBeenCalled()
      expect(notePaneLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          paneKey: `${TAB_ID}:${LEAF_ID}`,
          claudeShellAccount: { accountId: 'account-a' },
          resumedSessionId: 's1',
          fresh: true
        })
      )
    }
  )

  it.each(['window', 'host'] as const)(
    'leaves a conversation nobody kept on the selection, with the same calls: %s lane',
    async (lane) => {
      installKeptIndex({})
      const spawn = installFakeLocalProvider('pty-claude')
      const prepareClaudeAuth = vi.fn(async () => SELECTED_AUTH)

      await lanes[lane](prepareClaudeAuth)

      expect(withClaudeProfileTerminalEnv).toHaveBeenCalledWith(
        expect.objectContaining({ KEEP: 'me' }),
        { runtime: 'host' }
      )
      expect(prepareClaudeAuth).toHaveBeenCalledWith({ runtime: 'host' })
      expect(withClaudeKeptAccountTerminalEnv).not.toHaveBeenCalled()
      expect(prepareInstalledClaudeLaunchForAccount).not.toHaveBeenCalled()
      expect(spawn.mock.calls[0]![0].env?.ORCA_CLAUDE_PROFILE_POINTER).toBe(
        '/data/claude-profiles/selected-host'
      )
    }
  )

  it.each(['window', 'host'] as const)(
    'refuses before spawning while the index cannot be read: %s lane',
    async (lane) => {
      installKeptIndex('unavailable')
      const spawn = installFakeLocalProvider('pty-claude')
      await expect(lanes[lane](vi.fn(async () => SELECTED_AUTH))).rejects.toThrow(/could not read/)
      expect(spawn).not.toHaveBeenCalled()
    }
  )
})
