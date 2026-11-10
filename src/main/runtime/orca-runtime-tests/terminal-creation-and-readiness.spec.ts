import { describe, expect, it, vi } from 'vitest'
import { committingSpawn, registerLivePty } from './bind-first-pane.test-fixture'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { electronMocks } from '../orca-runtime-test-mocks/setup.spec'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import {
  HEADLESS_LEAF_ID,
  RESTORED_AUTHORITY_TOKEN,
  RESTORED_AUTHORITY_TOKEN_HASH,
  TEST_REPO_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  deferred,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from './orca-runtime-test-fixtures.spec'
import { spawnedPtyEnv } from '../terminal/launch/spawned-pty-env-fixtures'
import '../../../shared/jcode-runtime-dir'

describe('OrcaRuntimeService', () => {
  it('refuses a requested shell the execution host cannot apply instead of spawning its default', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-unreachable-shell' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    // Host platform here is POSIX, which has no Windows shell to pick.
    await expect(
      runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { shellOverride: 'cmd.exe' })
    ).rejects.toThrow(/--shell cmd\.exe names a Windows shell/)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('quotes the agent startup command for the requested shell, not the host default', async () => {
    const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const spawn = vi.fn().mockResolvedValue({ id: 'pty-shell-quoting' })
      const runtime = new OrcaRuntimeService({
        ...store,
        getSettings: () => ({
          ...store.getSettings(),
          disabledTuiAgents: [],
          terminalWindowsShell: 'powershell.exe',
          agentCmdOverrides: {},
          agentDefaultArgs: { claude: '--dangerously-skip-permissions' },
          agentDefaultEnv: {}
        })
      })
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

      await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { command: 'claude' })
      await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        command: 'claude',
        shellOverride: 'cmd.exe'
      })

      // Quote for the selected shell, even when Settings names a different Windows default.
      expect(spawn).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ command: "claude '--dangerously-skip-permissions'" })
      )
      expect(spawn).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          shellOverride: 'cmd.exe',
          command: 'claude "--dangerously-skip-permissions"'
        })
      )
    } finally {
      Object.defineProperty(process, 'platform', hostPlatform)
    }
  })

  it('refuses a requested shell with no workspace instead of creating a default-shell tab', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-no-workspace-shell' })
    const send = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents: { send }
    })

    await expect(runtime.createTerminal(undefined, { shellOverride: 'cmd.exe' })).rejects.toThrow(
      /--shell cmd\.exe needs a workspace/
    )
    expect(send).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('retires inherited launch authority when the agent command exits', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-authority', incarnationId: 'process-1' })
    const retireAuthority = vi.fn()
    const runtime = new OrcaRuntimeService(store, undefined, {
      attestAgentHookCompatibilityAuthority: (candidate) => ({
        paneKey: candidate.paneKey,
        source: 'current_hook'
      }),
      retireAgentHookCompatibilityAuthority: retireAuthority
    })
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-authority' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const terminal = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      launchAgent: 'codex',
      launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
    })
    const spawnEnv = spawnedPtyEnv(spawn.mock.calls[0]?.[0])
    const evidence = {
      terminalHandle: terminal.handle,
      paneKey: spawnEnv.ORCA_PANE_KEY,
      launchToken: spawnEnv.ORCA_AGENT_LAUNCH_TOKEN
    }

    expect(runtime.verifyOrchestrationCompatibilityCaller(evidence)).not.toBeNull()
    expect((await runtime.listTerminals()).terminals).toEqual([
      expect.objectContaining({ handle: terminal.handle, agentIdentity: 'codex' })
    ])

    runtime.onPtyData('pty-authority', '\x1b]133;D;0\x07', 100)

    expect(retireAuthority).toHaveBeenCalledWith(spawnEnv.ORCA_PANE_KEY)
    expect(runtime.verifyOrchestrationCompatibilityCaller(evidence)).toBeNull()
    expect((await runtime.listTerminals()).terminals).toEqual([
      expect.not.objectContaining({ agentIdentity: expect.anything() })
    ])
  })

  it('restores a retained coordinator handle after a late controller inventory', async () => {
    const paneKey = makePaneKey('host-tab', HEADLESS_LEAF_ID)
    const incarnationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const session = makeWorkspaceSessionWithHeadlessTerminal({
      terminalPtyIncarnationsByPaneKey: { [paneKey]: incarnationId }
    })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      canRecoverPersistentLocalPtys: () => true,
      attestAgentHookCompatibilityAuthority: ({ paneKey: candidate, launchTokenHash }) =>
        candidate === paneKey && launchTokenHash === RESTORED_AUTHORITY_TOKEN_HASH
          ? { paneKey: candidate, source: 'hydrated_commitment' }
          : null
    })
    const controllerHandle = 'term_retained_coordinator'
    const listProcesses = vi
      .fn()
      .mockRejectedValueOnce(new Error('provider starting'))
      .mockResolvedValue([
        {
          id: 'persisted-pty',
          incarnationId,
          terminalHandle: controllerHandle,
          title: 'Coordinator',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ])
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
    })

    await expect(runtime.refreshRestoredOrchestrationAuthority()).rejects.toThrow(
      'terminal_liveness_unavailable'
    )
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Coordinator',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: 'persisted-pty'
        }
      ]
    })
    registerLivePty(runtime, 'persisted-pty', TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      incarnationId
    })
    const syntheticHandle = runtime.getAgentStatusTerminalHandleForPaneKey(paneKey)
    expect(syntheticHandle).toMatch(/^term_/)
    expect(syntheticHandle).not.toBe(controllerHandle)

    await expect(runtime.refreshRestoredOrchestrationAuthority()).resolves.toBeUndefined()

    expect(runtime.getAgentStatusTerminalHandleForPaneKey(paneKey)).toBe(controllerHandle)
    expect(
      runtime.verifyOrchestrationCompatibilityCaller({
        terminalHandle: controllerHandle,
        paneKey,
        launchToken: RESTORED_AUTHORITY_TOKEN
      })
    ).toMatchObject({
      terminalHandle: controllerHandle,
      paneKey,
      processIncarnation: `persisted-pty:${incarnationId}`
    })
  })

  it('drops an out-of-order aggregate inventory after a newer SSH inventory', async () => {
    const targetId = 'ssh-1'
    const ptyId = `ssh:${targetId}@@persisted-pty`
    const paneKey = makePaneKey('host-tab', HEADLESS_LEAF_ID)
    const oldIncarnation = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const newIncarnation = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const session = makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'host-tab',
            ptyId,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Persisted Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: ptyId })
      },
      terminalPtyIncarnationsByPaneKey: { [paneKey]: oldIncarnation }
    })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      attestAgentHookCompatibilityAuthority: ({ paneKey: candidate, launchTokenHash }) =>
        candidate === paneKey && launchTokenHash === RESTORED_AUTHORITY_TOKEN_HASH
          ? { paneKey: candidate, source: 'hydrated_commitment' }
          : null
    })
    const oldInventory = deferred<
      {
        id: string
        incarnationId: string
        terminalHandle: string
        worktreeId: string
        cwd: string
        title: string
        wslDistro: null
      }[]
    >()
    const newInventory =
      deferred<typeof oldInventory.promise extends Promise<infer T> ? T : never>()
    const listProcesses = vi
      .fn()
      .mockImplementationOnce(() => oldInventory.promise)
      .mockImplementationOnce(() => newInventory.promise)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses
    })
    const internals = runtime as unknown as {
      refreshPtyWorktreeRecordsWithControllerInventory: (
        worktrees: [],
        targetWorktreeId: string | null,
        deadline: number | undefined,
        connectionId: string | null | undefined
      ) => Promise<unknown>
      ptysById: Map<string, { incarnationId: string | null }>
      restoredOrchestrationAuthorityByPtyId: Map<string, unknown>
    }
    const host = runtime.registerOrchestrationCompatibilitySshAttachment(
      targetId,
      'connection-incarnation'
    )

    const staleRefresh = internals.refreshPtyWorktreeRecordsWithControllerInventory(
      [],
      null,
      undefined,
      undefined
    )
    const currentRefresh = internals.refreshPtyWorktreeRecordsWithControllerInventory(
      [],
      null,
      undefined,
      targetId
    )
    newInventory.resolve([
      {
        id: ptyId,
        incarnationId: newIncarnation,
        terminalHandle: 'term_new_process',
        worktreeId: TEST_WORKTREE_ID,
        cwd: TEST_WORKTREE_PATH,
        title: 'Replacement',
        wslDistro: null
      }
    ])
    await expect(currentRefresh).resolves.not.toBeNull()
    oldInventory.resolve([
      {
        id: ptyId,
        incarnationId: oldIncarnation,
        terminalHandle: 'term_old_process',
        worktreeId: TEST_WORKTREE_ID,
        cwd: TEST_WORKTREE_PATH,
        title: 'Retained coordinator',
        wslDistro: null
      }
    ])
    await expect(staleRefresh).resolves.toBeNull()

    expect(internals.ptysById.get(ptyId)?.incarnationId).toBe(newIncarnation)
    expect(internals.restoredOrchestrationAuthorityByPtyId.has(ptyId)).toBe(false)
    expect(
      runtime.verifyOrchestrationCompatibilityCaller({
        terminalHandle: 'term_old_process',
        paneKey,
        launchToken: RESTORED_AUTHORITY_TOKEN,
        host
      })
    ).toBeNull()
  })

  it('keeps restored receipts outside a targeted worktree scan', async () => {
    const secondWorktreeId = `${TEST_REPO_ID}::/tmp/worktree-b`
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-moved',
          incarnationId: 'inc-moved',
          terminalHandle: 'term_moved',
          title: 'Moved',
          cwd: '/tmp/worktree-b',
          worktreeId: secondWorktreeId,
          wslDistro: null
        },
        {
          id: 'pty-second',
          incarnationId: 'inc-second',
          terminalHandle: 'term_second',
          title: 'Second',
          cwd: '/tmp/worktree-b',
          worktreeId: secondWorktreeId,
          wslDistro: null
        }
      ]
    })
    const receipts = (
      runtime as unknown as {
        restoredOrchestrationAuthorityByPtyId: Map<string, Record<string, unknown>>
      }
    ).restoredOrchestrationAuthorityByPtyId
    receipts.set('pty-moved', {
      ptyId: 'pty-moved',
      worktreeId: TEST_WORKTREE_ID,
      terminalHandle: 'term_moved',
      paneKey: makePaneKey('moved-tab', HEADLESS_LEAF_ID),
      processIncarnation: 'pty-moved:inc-moved',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    receipts.set('pty-second', {
      ptyId: 'pty-second',
      worktreeId: secondWorktreeId,
      terminalHandle: 'term_second',
      paneKey: makePaneKey('second-tab', HEADLESS_LEAF_ID),
      processIncarnation: 'pty-second:inc-second',
      hostScope: { kind: 'local', hostId: 'local' }
    })

    await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)

    expect(receipts.has('pty-moved')).toBe(false)
    expect(receipts.has('pty-second')).toBe(true)
  })
})
