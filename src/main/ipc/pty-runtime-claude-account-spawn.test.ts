import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers, registerSshPtyProvider } from './pty'
import { hasLiveClaudePtys, markClaudePtyExited } from '../claude-accounts/live-pty-gate'
import {
  _internals as pinnedRegistryInternals,
  countClaudePinnedAccountUsers,
  hasLivePinnedClaudePtys
} from '../claude-accounts/claude-pinned-pty-registry'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'

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

type RuntimeSpawnArgs = {
  cols: number
  rows: number
  worktreeId?: string
  command?: string
  launchAgent?: 'claude' | 'codex'
  connectionId?: string | null
  env?: Record<string, string>
  claudeAccountId?: string
}
type RuntimeSpawnController = { spawn(args: RuntimeSpawnArgs): Promise<{ id: string }> }

const ACTIVE_PREPARATION: ClaudeRuntimeAuthPreparation = {
  configDir: '/home/user/.claude',
  runtime: 'host',
  wslDistro: null,
  wslLinuxConfigDir: null,
  envPatch: {},
  stripAuthEnv: true,
  provenance: 'managed:acct-a'
}

const PINNED_DIR = '/userData/claude-accounts/acct-b/auth'
const PINNED_PREPARATION: ClaudeRuntimeAuthPreparation = {
  configDir: PINNED_DIR,
  runtime: 'host',
  wslDistro: null,
  wslLinuxConfigDir: null,
  envPatch: { CLAUDE_CONFIG_DIR: PINNED_DIR, CLAUDE_SECURESTORAGE_CONFIG_DIR: PINNED_DIR },
  stripAuthEnv: true,
  pinnedAccountId: 'acct-b',
  provenance: 'managed:acct-b:pinned'
}

describe('runtime PTY spawn pinned to a Claude account', () => {
  const { mainWindow } = setupPtyIpcSuite()

  function registerRuntimeController(
    prepareClaudeAuth: (...args: unknown[]) => Promise<ClaudeRuntimeAuthPreparation>
  ): RuntimeSpawnController {
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value: RuntimeSpawnController) => {
        controller = value
      }),
      preAllocateHandleForPty: vi.fn(() => 'term_pinned'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' })),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      prepareClaudeAuth
    )
    if (!controller) {
      throw new Error('runtime PTY controller was not registered')
    }
    return controller
  }

  function lastSpawnEnv(): Record<string, string> {
    return spawnMock.mock.calls.at(-1)![2].env as Record<string, string>
  }

  function cleanup(ids: string[]): void {
    for (const id of ids) {
      markClaudePtyExited(id)
    }
    pinnedRegistryInternals.reset()
  }

  it('leaves a launch without --account byte-for-byte unchanged', async () => {
    const prepareClaudeAuth = vi.fn(async () => ACTIVE_PREPARATION)
    const controller = registerRuntimeController(prepareClaudeAuth)
    const args = { cols: 80, rows: 24, worktreeId: 'wt-1', command: 'claude', env: { KEEP: '1' } }

    const plain = await controller.spawn(args)
    const plainEnv = lastSpawnEnv()
    const plainSpawnOptions = { ...spawnMock.mock.calls.at(-1)![2], env: undefined }
    // Why: `--account` naming the host's active account resolves to the same preparation, so any
    // difference between these two spawns would be the new branch leaking into the old path.
    const activePinned = await controller.spawn({ ...args, claudeAccountId: 'acct-a' })
    const activePinnedEnv = lastSpawnEnv()
    try {
      expect(prepareClaudeAuth.mock.calls[0]).toHaveLength(1)
      expect(prepareClaudeAuth.mock.calls[1]?.[1]).toEqual({ accountId: 'acct-a' })
      expect(plainEnv).not.toHaveProperty('CLAUDE_CONFIG_DIR')
      expect(plainEnv).not.toHaveProperty('CLAUDE_SECURESTORAGE_CONFIG_DIR')
      expect(plainEnv.KEEP).toBe('1')
      const withoutPerSpawnIds = (env: Record<string, string>) =>
        Object.fromEntries(
          Object.entries(env).filter(
            ([key]) => !/^ORCA_(PANE_KEY|TERMINAL_HANDLE|PTY_ID)/.test(key)
          )
        )
      expect(withoutPerSpawnIds(activePinnedEnv)).toEqual(withoutPerSpawnIds(plainEnv))
      expect({ ...spawnMock.mock.calls.at(-1)![2], env: undefined }).toEqual(plainSpawnOptions)
      expect(hasLiveClaudePtys()).toBe(true)
      expect(countClaudePinnedAccountUsers('acct-a')).toBe(0)
    } finally {
      cleanup([plain.id, activePinned.id])
    }
  })

  it('spawns a pinned Claude on the managed dir and tracks it per account', async () => {
    const prepareClaudeAuth = vi.fn(async () => PINNED_PREPARATION)
    const controller = registerRuntimeController(prepareClaudeAuth)

    const spawned = await controller.spawn({
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      command: 'claude',
      claudeAccountId: 'acct-b'
    })
    try {
      const env = lastSpawnEnv()
      expect(env.CLAUDE_CONFIG_DIR).toBe(PINNED_DIR)
      expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(PINNED_DIR)
      expect(prepareClaudeAuth).toHaveBeenCalledWith({ runtime: 'host' }, { accountId: 'acct-b' })
      expect(hasLiveClaudePtys()).toBe(false)
      expect(hasLivePinnedClaudePtys('acct-b')).toBe(true)
      markClaudePtyExited(spawned.id)
      expect(hasLivePinnedClaudePtys('acct-b')).toBe(false)
    } finally {
      cleanup([spawned.id])
    }
  })

  it('treats a gated setup launch as Claude when the agent id says so', async () => {
    const prepareClaudeAuth = vi.fn(async () => PINNED_PREPARATION)
    const controller = registerRuntimeController(prepareClaudeAuth)
    const spawned = await controller.spawn({
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      command: `bash -lc 'eval "$ORCA_SETUP_GATE"'`,
      launchAgent: 'claude',
      claudeAccountId: 'acct-b'
    })
    try {
      expect(prepareClaudeAuth).toHaveBeenCalledTimes(1)
      expect(lastSpawnEnv().CLAUDE_CONFIG_DIR).toBe(PINNED_DIR)
    } finally {
      cleanup([spawned.id])
    }
  })

  it('refuses non-Claude and SSH launches before preparing any credentials', async () => {
    const prepareClaudeAuth = vi.fn(async () => PINNED_PREPARATION)
    const controller = registerRuntimeController(prepareClaudeAuth)
    registerSshPtyProvider('ssh-1', { spawn: vi.fn() } as never)

    await expect(
      controller.spawn({
        cols: 80,
        rows: 24,
        worktreeId: 'wt-1',
        command: 'codex',
        claudeAccountId: 'acct-b'
      })
    ).rejects.toThrow('--account applies only to Claude launches.')
    await expect(
      controller.spawn({
        cols: 80,
        rows: 24,
        worktreeId: 'wt-1',
        command: 'claude',
        connectionId: 'ssh-1',
        claudeAccountId: 'acct-b'
      })
    ).rejects.toThrow('not supported for SSH workspaces')
    expect(prepareClaudeAuth).not.toHaveBeenCalled()
  })

  it('refuses to launch when the prepared account is not the requested one', async () => {
    const prepareClaudeAuth = vi.fn(async () => ({
      ...ACTIVE_PREPARATION,
      provenance: 'managed:acct-c'
    }))
    const controller = registerRuntimeController(prepareClaudeAuth)
    const spawnsBefore = spawnMock.mock.calls.length
    await expect(
      controller.spawn({
        cols: 80,
        rows: 24,
        worktreeId: 'wt-1',
        command: 'claude',
        claudeAccountId: 'acct-b'
      })
    ).rejects.toThrow(/could not prepare the requested Claude account/)
    expect(spawnMock.mock.calls.length).toBe(spawnsBefore)
  })

  it('keeps the env-conflict refusal and releases the reservation of a failed spawn', async () => {
    const prepareClaudeAuth = vi.fn(async () => {
      // Mirrors the service: preparation reserves the account for the spawn to release.
      const { reserveClaudePinnedAccount } =
        await import('../claude-accounts/claude-pinned-pty-registry')
      reserveClaudePinnedAccount('acct-b')
      return PINNED_PREPARATION
    })
    const controller = registerRuntimeController(prepareClaudeAuth)
    try {
      await expect(
        controller.spawn({
          cols: 80,
          rows: 24,
          worktreeId: 'wt-1',
          command: 'claude',
          env: { ANTHROPIC_API_KEY: 'sk-test' },
          claudeAccountId: 'acct-b'
        })
      ).rejects.toThrow(/explicit Anthropic auth environment variables/)
      expect(countClaudePinnedAccountUsers('acct-b')).toBe(0)
    } finally {
      cleanup([])
    }
  })
})
