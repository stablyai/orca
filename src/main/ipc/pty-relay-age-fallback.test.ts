import { describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { trackMock } from './pty-ipc-mock-registry'
import { registerPtyHandlers, registerSshPtyProvider } from './pty'
import { SshPtyAbsentFromRelayError } from '../providers/ssh-pty-errors'

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

describe('relay-process-aware pane fallback', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  it('starts a plain shell and reports an unverifiable resume after relay replacement', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const connectionId = 'ssh-1'
    const worktreeId = 'repo-1::/remote/worktree'
    const tabId = 'tab-relay-replacement'
    const leafId = '56565656-5656-4656-8656-565656565656'
    const paneKey = makePaneKey(tabId, leafId)
    const oldPtyId = `ssh:${connectionId}@@old-pty`
    const newPtyId = `ssh:${connectionId}@@new-pty`
    const providerSpawn = vi.fn(async (options: { attachOnly?: boolean }) => {
      if (options.attachOnly) {
        throw new SshPtyAbsentFromRelayError('SSH_SESSION_EXPIRED: old-pty')
      }
      return {
        id: newPtyId,
        incarnationId: 'new-incarnation',
        relayProcessId: 'replacement-relay-process'
      }
    })
    registerSshPtyProvider(connectionId, {
      spawn: providerSpawn,
      requestHostRpc: vi.fn(async () => ({
        relayProcessId: 'replacement-relay-process',
        uptimeMs: Number.MAX_SAFE_INTEGER
      })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    let session = {
      tabsByWorktree: { [worktreeId]: [{ id: tabId, worktreeId, ptyId: oldPtyId }] },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: { type: 'leaf' as const, leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: oldPtyId }
        }
      },
      terminalPtyIncarnationsByPaneKey: { [paneKey]: 'old-incarnation' }
    }
    const store = {
      getWorkspaceSession: vi.fn(() => session),
      setWorkspaceSession: vi.fn((next) => {
        session = next
      }),
      flushOrThrow: vi.fn(),
      persistPtyBinding: vi.fn(),
      getSshRemotePtyLeases: vi.fn(() => [
        {
          targetId: connectionId,
          ptyId: 'old-pty',
          worktreeId,
          tabId,
          leafId,
          state: 'detached',
          createdAt: 1_000,
          updatedAt: 1_000,
          relayProcessId: 'original-relay-process'
        }
      ]),
      upsertSshRemotePtyLease: vi.fn(),
      getFolderWorkspace: vi.fn(() => undefined),
      getFolderWorkspaces: vi.fn(() => []),
      getProjectGroups: vi.fn(() => []),
      getRepos: vi.fn(() => [])
    }
    const runtime = {
      setPtyController: vi.fn(),
      resolveTerminalPane: vi.fn(() => {
        throw new Error('terminal_not_found')
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term-relay-replacement'),
      preAllocateHandleForPty: vi.fn(() => 'term-relay-replacement'),
      registerPreAllocatedHandleForPty: vi.fn(),
      beginPtyRegistration: vi.fn(),
      cancelPendingPtyRegistration: vi.fn(),
      assertPtyRegistrationAllowed: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      seedHeadlessTerminal: vi.fn(),
      onPtySpawned: vi.fn(),
      markPtyLivenessUnverifiable: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      store as never
    )

    const mounted = await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: '/remote/worktree',
      command: 'codex resume old-session',
      commandDelivery: 'provider',
      startupCommandDelivery: 'shell-ready',
      launchAgent: 'codex',
      launchConfig: { agent: 'codex', agentCommand: 'codex resume old-session' },
      launchToken: 'launch-token',
      connectionId,
      worktreeId,
      tabId,
      leafId,
      terminalColorQueryReplies: { foreground: 'rgb:ffff/ffff/ffff' },
      env: {
        ORCA_PANE_KEY: paneKey,
        ORCA_TAB_ID: tabId,
        ORCA_WORKTREE_ID: worktreeId,
        ORCA_AGENT_LAUNCH_TOKEN: 'launch-token'
      },
      telemetry: {
        agent_kind: 'codex',
        launch_source: 'new_workspace_composer',
        request_kind: 'resume'
      }
    })

    expect(mounted).toMatchObject({ id: newPtyId, agentResumeUnavailable: true })
    expect(mounted).not.toHaveProperty('launchConfig')
    expect(providerSpawn).toHaveBeenCalledTimes(2)
    expect(providerSpawn.mock.calls[1]?.[0]).toMatchObject({
      command: undefined,
      commandDelivery: undefined,
      startupCommandDelivery: undefined,
      launchAgent: undefined,
      agentSessionEnsure: undefined,
      agentSessionCreateOperationId: undefined,
      env: expect.not.objectContaining({ ORCA_AGENT_LAUNCH_TOKEN: expect.anything() })
    })
    expect(runtime.markPtyLivenessUnverifiable).toHaveBeenCalledWith(
      oldPtyId,
      expect.stringContaining('cannot be proven')
    )
    expect(runtime.onPtyExit).toHaveBeenCalledWith(oldPtyId, -1, 'old-incarnation')
    expect(runtime.noteTerminalSpawnCommand).toHaveBeenCalledWith(newPtyId, null)
    expect(runtime.registerPty.mock.calls.at(-1)?.[3]).not.toHaveProperty('agentLaunchAuthority')
    expect(store.upsertSshRemotePtyLease).toHaveBeenCalledWith(
      expect.objectContaining({
        ptyId: 'new-pty',
        relayProcessId: 'replacement-relay-process'
      })
    )
    expect(trackMock).not.toHaveBeenCalledWith('agent_started', expect.anything())
  })
})
