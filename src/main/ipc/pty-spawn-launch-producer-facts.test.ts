import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { classifyErrorMock, spawnMock, statSyncMock, trackMock } from './pty-ipc-mock-registry'
import {
  AUTOMATION_LEAF_ID,
  AUTOMATION_TAB_ID,
  automationSpawnRequest,
  createLaunchRuntimeStub,
  createLaunchStoreStub,
  installSshTestProvider,
  lastProviderSpawnOptions,
  launchShellSettings,
  pickKeys,
  registerLaunchHandlers
} from './pty-spawn-launch-test-fixture'
import type { LaunchRuntimeStub, LaunchStoreStub } from './pty-spawn-launch-test-fixture'

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

type ProviderKind = 'daemon' | 'ssh' | 'local'

const PANE_ENV_KEYS = [
  'ORCA_WORKSPACE_ID',
  'ORCA_PROJECT_GROUP_ID',
  'ORCA_WORKSPACE_ROOT',
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN',
  'ORCA_TERMINAL_HANDLE'
] as const
const PANE_KEY = `${AUTOMATION_TAB_ID}:${AUTOMATION_LEAF_ID}`
const SSH_REQUEST = {
  connectionId: 'ssh-1',
  cwd: '/home/u/repo',
  worktreeId: 'repo-1::/home/u/repo'
}

// Pins main's current launch behaviour as the convergence parity baseline (rows 1/2/5/6 window lane): per-producer env, delivery, telemetry and binding facts.
describe('pty:spawn launch producer facts (window lane, main half)', () => {
  const { handlers, mainWindow, installDaemonTestProvider } = setupPtyIpcSuite()
  const savedRemoteHooks = process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS

  beforeEach(() => {
    // Why: SSH pane env forwarding is gated on this flag; pin the default.
    delete process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS
  })

  afterEach(() => {
    if (savedRemoteHooks === undefined) {
      delete process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS
    } else {
      process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS = savedRemoteHooks
    }
  })

  type Spawned = {
    providerSpawn: Mock
    runtime: LaunchRuntimeStub
    store: LaunchStoreStub
    run: (request: Record<string, unknown>) => Promise<unknown>
  }

  function prepare(
    kind: ProviderKind,
    options: { settings?: Record<string, unknown>; spawnError?: Error } = {}
  ): Spawned {
    const providerSpawn = vi.fn(async (spawnOptions: { sessionId?: string }) => {
      if (options.spawnError) {
        throw options.spawnError
      }
      return { id: spawnOptions.sessionId ?? 'remote-pty' }
    })
    if (kind === 'ssh') {
      installSshTestProvider('ssh-1', providerSpawn)
    } else if (kind === 'daemon') {
      installDaemonTestProvider({ spawn: providerSpawn })
    }
    const runtime = createLaunchRuntimeStub()
    const store = createLaunchStoreStub()
    registerLaunchHandlers({
      mainWindow,
      runtime,
      store,
      settings: options.settings ?? launchShellSettings()
    })
    return {
      providerSpawn,
      runtime,
      store,
      run: (request) => Promise.resolve(handlers.get('pty:spawn')!(null, request))
    }
  }

  function spawnedEnv(kind: ProviderKind, providerSpawn: Mock): Record<string, unknown> {
    const env =
      kind === 'local'
        ? spawnMock.mock.calls.at(-1)?.[2]?.env
        : lastProviderSpawnOptions(providerSpawn).env
    if (!env || typeof env !== 'object') {
      throw new Error('spawn env missing')
    }
    return { ...env }
  }

  // Pins main's current launch behaviour as the convergence parity baseline (rows 1/2/5/6 pane env): workspace keys pass through, pane keys are rewritten, terminal handle per provider.
  describe('pane env', () => {
    it.each([
      { kind: 'daemon', handle: 'term_pre_allocated', preAllocations: 1 },
      { kind: 'ssh', handle: 'term_pre_allocated', preAllocations: 1 },
      // main today: plain LocalPtyProvider still stamps a handle, from the runtime's per-PTY allocator.
      { kind: 'local', handle: 'term_local_provider', preAllocations: 0 }
    ] as const)('$kind provider env', async ({ kind, handle, preAllocations }) => {
      const { providerSpawn, runtime, run } = prepare(kind)
      const host =
        kind === 'ssh' ? SSH_REQUEST : { cwd: '/work/f1', worktreeId: 'repo-1::/work/f1' }
      // Why a repo id with folder keys: main never reads the workspace kind for these keys.
      await run({
        cols: 80,
        rows: 24,
        ...host,
        tabId: AUTOMATION_TAB_ID,
        leafId: AUTOMATION_LEAF_ID,
        env: {
          ORCA_WORKSPACE_ID: 'folder:f1',
          ORCA_PROJECT_GROUP_ID: 'group-1',
          ORCA_WORKSPACE_ROOT: '/work/f1',
          ORCA_PANE_KEY: 'stale-pane-key',
          ORCA_TAB_ID: 'stale-tab',
          ORCA_WORKTREE_ID: 'stale-worktree',
          ORCA_AGENT_LAUNCH_TOKEN: 'launch-token-pane'
        }
      })
      expect(pickKeys(spawnedEnv(kind, providerSpawn), PANE_ENV_KEYS)).toEqual({
        ORCA_WORKSPACE_ID: 'folder:f1',
        ORCA_PROJECT_GROUP_ID: 'group-1',
        ORCA_WORKSPACE_ROOT: '/work/f1',
        ORCA_PANE_KEY: PANE_KEY,
        ORCA_TAB_ID: AUTOMATION_TAB_ID,
        ORCA_WORKTREE_ID: host.worktreeId,
        ORCA_AGENT_LAUNCH_TOKEN: 'launch-token-pane',
        ORCA_TERMINAL_HANDLE: handle
      })
      expect(runtime.createPreAllocatedTerminalHandle).toHaveBeenCalledTimes(preAllocations)
    })
  })

  // Pins main's current launch behaviour as the convergence parity baseline (row 5 automations, rows 1/2/6 SSH panes): startup delivery and size reach the provider verbatim.
  describe('startup delivery and size', () => {
    it.each([
      {
        name: 'SSH automation',
        kind: 'ssh',
        request: automationSpawnRequest({
          ...SSH_REQUEST,
          commandDelivery: 'provider',
          startupCommandDelivery: 'shell-ready'
        }),
        expected: {
          cols: 120,
          rows: 40,
          commandDelivery: 'provider',
          startupCommandDelivery: 'shell-ready'
        }
      },
      {
        name: 'local codex automation',
        kind: 'daemon',
        request: automationSpawnRequest({
          command: "codex 'run the automation'",
          launchAgent: 'codex',
          launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} },
          startupCommandDelivery: 'shell-ready',
          telemetry: { agent_kind: 'codex', launch_source: 'unknown', request_kind: 'new' }
        }),
        expected: { cols: 120, rows: 40, startupCommandDelivery: 'shell-ready' }
      },
      {
        name: 'local claude automation',
        kind: 'daemon',
        request: automationSpawnRequest(),
        expected: { cols: 120, rows: 40 }
      },
      {
        // main today: a hidden pane's unmeasured 0x0 grid is not clamped before the provider.
        name: 'unmeasured hidden pane',
        kind: 'daemon',
        request: { cols: 0, rows: 0, cwd: '/repo', worktreeId: 'repo-1::/repo' },
        expected: { cols: 0, rows: 0 }
      }
    ] as const)('$name', async ({ kind, request, expected }) => {
      const { providerSpawn, run } = prepare(kind)
      await run(request)
      expect(
        pickKeys(lastProviderSpawnOptions(providerSpawn), [
          'cols',
          'rows',
          'commandDelivery',
          'startupCommandDelivery'
        ])
      ).toEqual(expected)
    })
  })

  // Pins main's current launch behaviour as the convergence parity baseline (window-lane agent_error, rows 1/2/5/6): who gets an agent_error when the provider spawn throws.
  describe('agent_error on a failed provider spawn', () => {
    it.each([
      {
        name: 'renderer telemetry kind wins',
        kind: 'daemon',
        // Why claude: shows the telemetry kind outranks the claude command sniff.
        request: {
          command: 'claude',
          telemetry: { agent_kind: 'opencode', launch_source: 'unknown', request_kind: 'new' }
        },
        calls: [['agent_error', { agent_kind: 'opencode', error_class: 'binary_not_found' }]]
      },
      {
        name: 'local claude command without telemetry',
        kind: 'daemon',
        request: { command: 'claude' },
        calls: [['agent_error', { agent_kind: 'claude-code', error_class: 'binary_not_found' }]]
      },
      {
        name: 'non-claude command without telemetry',
        kind: 'daemon',
        request: { command: 'aider' },
        calls: []
      },
      // Why: the claude sniff is local-only, so an SSH claude without telemetry reports nothing.
      {
        name: 'SSH claude command without telemetry',
        kind: 'ssh',
        request: { ...SSH_REQUEST, command: 'claude' },
        calls: []
      }
    ] as const)('$name', async ({ kind, request, calls }) => {
      classifyErrorMock.mockReturnValue({ error_class: 'binary_not_found' })
      const { run } = prepare(kind, { spawnError: new Error('spawn boom') })
      await expect(
        run({ cols: 80, rows: 24, cwd: '/repo', worktreeId: 'repo-1::/repo', ...request })
      ).rejects.toThrow('spawn boom')
      expect(trackMock.mock.calls).toEqual(calls)
    })
  })

  // Pins main's current launch behaviour as the convergence parity baseline (row 5 automations): telemetry, binding, cwd and disabled-agent facts for the automation payload.
  describe('desktop automation payload', () => {
    it('emits exactly one agent_started with launch_source unknown', async () => {
      const { run } = prepare('daemon')
      await run(automationSpawnRequest())
      expect(trackMock.mock.calls).toEqual([
        [
          'agent_started',
          { agent_kind: 'claude-code', launch_source: 'unknown', request_kind: 'new' }
        ]
      ])
    })

    it('persists the new-tab placement binding without host-admitted membership', async () => {
      const { store, run } = prepare('daemon')
      await run(automationSpawnRequest())
      expect(store.persistPtyBinding.mock.calls).toEqual([
        [
          {
            worktreeId: 'repo-1::/repo',
            tabId: AUTOMATION_TAB_ID,
            leafId: AUTOMATION_LEAF_ID,
            ptyId: expect.any(String),
            startupCwd: '/repo',
            placement: { kind: 'new-tab', row: { customTitle: 'Nightly audit' } },
            origin: 'spawn'
          }
        ]
      ])
    })

    it('persists an SSH pane binding with the SSH execution host id', async () => {
      const { store, run } = prepare('ssh')
      await run(
        automationSpawnRequest({
          ...SSH_REQUEST,
          commandDelivery: 'provider',
          startupCommandDelivery: 'shell-ready'
        })
      )
      expect(store.persistPtyBinding.mock.calls).toEqual([
        [
          {
            worktreeId: SSH_REQUEST.worktreeId,
            tabId: AUTOMATION_TAB_ID,
            leafId: AUTOMATION_LEAF_ID,
            ptyId: 'remote-pty',
            startupCwd: '/home/u/repo',
            placement: { kind: 'new-tab', row: { customTitle: 'Nightly audit' } },
            origin: 'spawn'
          },
          'ssh:ssh-1'
        ]
      ])
    })

    // The full fallback matrix lives in pty-spawn-cwd-fallback.test.ts; this is only the contrast row.
    it.each([
      { cwdFallback: undefined, cwd: '/repo/deleted', reply: undefined },
      { cwdFallback: 'worktree', cwd: '/repo', reply: { kind: 'worktree', cwd: '/repo' } }
    ] as const)(
      'missing cwd with cwdFallback $cwdFallback reaches the provider as $cwd',
      async ({ cwdFallback, cwd, reply }) => {
        statSyncMock.mockImplementation((target: string) => {
          if (target === '/repo/deleted') {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          }
          return { isDirectory: () => true, mode: 0o755, size: 1 }
        })
        const { providerSpawn, run } = prepare('daemon')
        const result = await run(
          automationSpawnRequest({ cwd: '/repo/deleted', ...(cwdFallback ? { cwdFallback } : {}) })
        )
        expect(lastProviderSpawnOptions(providerSpawn).cwd).toBe(cwd)
        const replyFields = result && typeof result === 'object' ? { ...result } : {}
        expect(pickKeys(replyFields, ['startupCwdFallback'])).toEqual(
          reply ? { startupCwdFallback: reply } : {}
        )
      }
    )

    it('still spawns a claude automation that settings disabled', async () => {
      const { providerSpawn, run } = prepare('daemon', {
        settings: launchShellSettings({ disabledTuiAgents: ['claude'] })
      })
      await run(automationSpawnRequest())
      expect(providerSpawn).toHaveBeenCalledOnce()
      expect(pickKeys(lastProviderSpawnOptions(providerSpawn), ['command', 'launchAgent'])).toEqual(
        {
          command: "claude '--dangerously-skip-permissions' 'run the automation'",
          launchAgent: 'claude'
        }
      )
    })
  })
})
