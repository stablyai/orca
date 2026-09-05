import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, makePaneKey } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  RESTORED_AUTHORITY_TOKEN,
  RESTORED_AUTHORITY_TOKEN_HASH,
  TEST_REPO_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  UUID_RE,
  deferred,
  expectStablePaneKeyEnv,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('creates visible terminal sessions without asking the renderer to focus a tab', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const createTerminal = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-bg' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal,
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const result = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      launchConfig: {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'captured' }
      },
      title: 'worker'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: TEST_WORKTREE_PATH,
        command: 'codex',
        commandDelivery: 'provider',
        worktreeId: TEST_WORKTREE_ID,
        preAllocatedHandle: expect.stringMatching(/^term_/)
      })
    )
    expect(result).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      title: 'worker',
      surface: 'visible'
    })
    expect(result.handle).toMatch(/^term_/)
    expect(createTerminal).not.toHaveBeenCalled()
    // Why: agent status keys off `${tabId}:${leafId}`; main pre-allocates the tabId, env-stamps it before spawn, and reuses it for adoption.
    const spawnCall = spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined
    const spawnedEnv = spawnCall?.env ?? {}
    expectStablePaneKeyEnv(spawnedEnv)
    const spawnedLeafId = spawnedEnv.ORCA_PANE_KEY.slice(`${spawnedEnv.ORCA_TAB_ID}:`.length)
    expect(spawnedEnv.ORCA_WORKTREE_ID).toBe(TEST_WORKTREE_ID)
    expect(spawnedEnv.ORCA_AGENT_LAUNCH_TOKEN).toMatch(UUID_RE)
    expect(revealTerminalSession).toHaveBeenCalledWith(TEST_WORKTREE_ID, {
      ptyId: 'pty-bg',
      title: 'worker',
      launchConfig: {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'captured' }
      },
      launchToken: spawnedEnv.ORCA_AGENT_LAUNCH_TOKEN,
      activate: false,
      tabId: spawnedEnv.ORCA_TAB_ID,
      leafId: spawnedLeafId
    })
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
      spawn,
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
      sleepWorktree: vi.fn(),
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
    const spawnEnv =
      (spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    const evidence = {
      terminalHandle: terminal.handle,
      paneKey: spawnEnv.ORCA_PANE_KEY,
      launchToken: spawnEnv.ORCA_AGENT_LAUNCH_TOKEN
    }

    expect(runtime.verifyOrchestrationCompatibilityCaller(evidence)).not.toBeNull()
    expect(
      runtime.getAgentStatusLaunchConfigForPaneKey(spawnEnv.ORCA_PANE_KEY, {
        launchToken: spawnEnv.ORCA_AGENT_LAUNCH_TOKEN
      })
    ).toBeDefined()
    expect((await runtime.listTerminals()).terminals).toEqual([
      expect.objectContaining({ handle: terminal.handle, agentIdentity: 'codex' })
    ])

    runtime.onPtyData('pty-authority', '\x1b]133;D;0\x07', 100)

    expect(retireAuthority).toHaveBeenCalledWith(spawnEnv.ORCA_PANE_KEY)
    expect(runtime.verifyOrchestrationCompatibilityCaller(evidence)).toBeNull()
    expect(
      runtime.getAgentStatusLaunchConfigForPaneKey(spawnEnv.ORCA_PANE_KEY, {
        launchToken: spawnEnv.ORCA_AGENT_LAUNCH_TOKEN
      })
    ).toBeUndefined()
    expect((await runtime.listTerminals()).terminals).toEqual([
      expect.not.objectContaining({ agentIdentity: expect.anything() })
    ])
  })

  it('retires only receipted restored PTY authority on command completion and exit', () => {
    const retireAuthority = vi.fn()
    const runtime = new OrcaRuntimeService(store, undefined, {
      retireAgentHookCompatibilityAuthority: retireAuthority
    })
    const internals = runtime as unknown as {
      recordPtyWorktree: (ptyId: string, worktreeId: string, state: Record<string, unknown>) => void
      restoredOrchestrationAuthorityByPtyId: Map<string, Record<string, unknown>>
    }
    const firstPane = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222'
    const secondPane = '33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444'
    internals.recordPtyWorktree('pty-restored-command', TEST_WORKTREE_ID, {
      connected: true,
      tabId: '11111111-1111-4111-8111-111111111111',
      paneKey: firstPane,
      incarnationId: 'restored-command'
    })
    internals.recordPtyWorktree('pty-restored-exit', TEST_WORKTREE_ID, {
      connected: true,
      tabId: '33333333-3333-4333-8333-333333333333',
      paneKey: secondPane,
      incarnationId: 'restored-exit'
    })
    internals.recordPtyWorktree('pty-ordinary-shell', TEST_WORKTREE_ID, {
      connected: true,
      tabId: '55555555-5555-4555-8555-555555555555',
      paneKey: '55555555-5555-4555-8555-555555555555:66666666-6666-4666-8666-666666666666',
      incarnationId: 'ordinary-shell'
    })
    internals.restoredOrchestrationAuthorityByPtyId.set('pty-restored-command', {
      ptyId: 'pty-restored-command',
      worktreeId: TEST_WORKTREE_ID,
      terminalHandle: 'term-restored-command',
      paneKey: firstPane,
      processIncarnation: 'pty-restored-command:restored-command',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    internals.restoredOrchestrationAuthorityByPtyId.set('pty-restored-exit', {
      ptyId: 'pty-restored-exit',
      worktreeId: TEST_WORKTREE_ID,
      terminalHandle: 'term-restored-exit',
      paneKey: secondPane,
      processIncarnation: 'pty-restored-exit:restored-exit',
      hostScope: { kind: 'local', hostId: 'local' }
    })

    runtime.emitDaemonPtyTransientFact('pty-restored-command', {
      kind: 'command-finished',
      exitCode: 0
    })
    runtime.onPtyExit('pty-restored-exit', 0, 'restored-exit')
    runtime.onPtyExit('pty-ordinary-shell', 0, 'ordinary-shell')

    expect(retireAuthority).toHaveBeenCalledWith(firstPane)
    expect(retireAuthority).toHaveBeenCalledWith(secondPane)
    expect(retireAuthority).toHaveBeenCalledTimes(2)
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

  it('forgets synthetic handles when disconnected PTY records are pruned', () => {
    const runtime = new OrcaRuntimeService(store)
    const internals = runtime as unknown as {
      recordPtyWorktree: (
        ptyId: string,
        worktreeId: string,
        state: Record<string, unknown>
      ) => unknown
      issuePtyHandle: (pty: unknown) => string
      dropDisconnectedPtyRecord: (ptyId: string) => void
      syntheticTerminalHandles: Set<string>
    }
    const pty = internals.recordPtyWorktree('pty-pruned', TEST_WORKTREE_ID, {
      connected: false
    })
    const handle = internals.issuePtyHandle(pty)
    expect(internals.syntheticTerminalHandles.has(handle)).toBe(true)

    internals.dropDisconnectedPtyRecord('pty-pruned')

    expect(internals.syntheticTerminalHandles.has(handle)).toBe(false)
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
