import { describe, expect, it, vi } from 'vitest'
import {
  FLOATING_TERMINAL_WORKTREE_ID,
  OrcaRuntimeService,
  electronMocks,
  registerSshGitProvider,
  unregisterSshGitProvider
} from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  createRuntime,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('starts unavailable with no authoritative window', () => {
    const runtime = createRuntime()

    expect(runtime.getStatus()).toMatchObject({
      graphStatus: 'unavailable',
      authoritativeWindowId: null,
      desktopWindowStatus: 'openable',
      rendererGraphEpoch: 0
    })
    expect(runtime.getRuntimeId()).toBeTruthy()
  })

  it('reports runtime protocol, capabilities, and mobile aliases on status', () => {
    const runtime = createRuntime()

    const status = runtime.getStatus()
    expect(typeof status.runtimeProtocolVersion).toBe('number')
    expect(typeof status.minCompatibleRuntimeClientVersion).toBe('number')
    expect(status.runtimeProtocolVersion).toBe(status.protocolVersion)
    expect(status.minCompatibleRuntimeClientVersion).toBe(status.minCompatibleMobileVersion)
    expect(status.capabilities).toContain('terminal.binary-stream.v1')
    expect(status.capabilities).toContain('workspace-ports.v1')
    expect(status.capabilities).toContain('mobile.tasks.v1')
    expect(status.capabilities).toContain('terminal.quick-commands.v1')
    expect(status.capabilities).toContain('worktree.create-idempotency.v1')
    expect(status.worktreeCreateIdempotency).toEqual({ dedupeTtlMs: 60_000 })
    expect(status.capabilities).toContain('files.mutation-ownership.v1')
    expect(status.capabilities).toContain('project-host-setup.v1')
    expect(status.capabilities).toContain('linear.issue-attribute-filter.v1')
    expect(status.capabilities).not.toContain('browser.screencast.v1')
    expect(typeof status.protocolVersion).toBe('number')
    expect(typeof status.minCompatibleMobileVersion).toBe('number')
    expect(status.protocolVersion).toBeGreaterThanOrEqual(1)
    expect(status.minCompatibleMobileVersion).toBeGreaterThanOrEqual(0)
  })

  it('reports the configured Windows terminal shell on status', () => {
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        terminalWindowsShell: 'wsl.exe'
      })
    } as never)

    expect(runtime.getStatus().terminalWindowsShell).toBe('wsl.exe')
  })

  it('reports floating workspace availability from settings on status', () => {
    expect(createRuntime().getStatus().floatingWorkspaceEnabled).toBe(true)

    const disabledRuntime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        floatingTerminalEnabled: false
      })
    } as never)
    expect(disabledRuntime.getStatus().floatingWorkspaceEnabled).toBe(false)
  })

  it('polls floating tabs with targeted PTY liveness and no repo/provider inventory', async () => {
    const getRepos = vi.fn(store.getRepos)
    const listProcesses = vi.fn().mockResolvedValue([])
    const floatingPtyId = `${FLOATING_TERMINAL_WORKTREE_ID}@@pty-1`
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        activeRepoId: null,
        activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        activeTabIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: 'floating-tab' },
        tabsByWorktree: {
          [FLOATING_TERMINAL_WORKTREE_ID]: [
            {
              id: 'floating-tab',
              ptyId: floatingPtyId,
              worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
              title: 'Floating Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'floating-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: floatingPtyId })
        }
      })
    )
    const runtime = new OrcaRuntimeService({ ...runtimeStore, getRepos } as never)
    const ptyController = {
      livePtyIds: new Set([floatingPtyId]),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      hasPty(this: { livePtyIds: Set<string> }, ptyId: string) {
        return this.livePtyIds.has(ptyId)
      },
      listProcesses
    }
    const hasPty = vi.spyOn(ptyController, 'hasPty')
    runtime.setPtyController(ptyController)

    const tabs = await runtime.listMobileSessionTabs(`id:${FLOATING_TERMINAL_WORKTREE_ID}`)
    const terminals = await runtime.listTerminals(`id:${FLOATING_TERMINAL_WORKTREE_ID}`)
    await runtime.listMobileSessionTabs(`id:${FLOATING_TERMINAL_WORKTREE_ID}`)
    await runtime.listTerminals(`id:${FLOATING_TERMINAL_WORKTREE_ID}`)

    expect(tabs.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        parentTabId: 'floating-tab',
        status: 'ready',
        terminal: expect.any(String)
      })
    ])
    expect(terminals.terminals).toEqual([
      expect.objectContaining({
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        connected: true
      })
    ])
    expect(hasPty).toHaveBeenCalledTimes(4)
    expect(hasPty).toHaveBeenCalledWith(floatingPtyId)
    expect(listProcesses).not.toHaveBeenCalled()
    // Why: a floating tab's worktree id carries no repoId, so the hydrate repo gate
    // must never resolve the inventory for it — #9343 made that read eager and
    // regressed this poll path. Keep both halves of the contract asserted.
    expect(getRepos).not.toHaveBeenCalled()
  })

  it('does not block a targeted mobile session tab list on an unrelated worktree scan', async () => {
    const remoteWorktreeId = 'repo-ssh::/remote/worktree'
    const remotePtyId = 'ssh:ssh-target@@remote-pty'
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        activeRepoId: 'repo-ssh',
        activeWorktreeId: remoteWorktreeId,
        activeTabIdByWorktree: { [remoteWorktreeId]: 'remote-tab' },
        tabsByWorktree: {
          [remoteWorktreeId]: [
            {
              id: 'remote-tab',
              ptyId: remotePtyId,
              worktreeId: remoteWorktreeId,
              title: 'Remote terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'remote-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: remotePtyId })
        }
      }),
      'ssh:ssh-target'
    )
    const remoteRepo = {
      ...store.getRepos()[0],
      id: 'repo-ssh',
      connectionId: 'ssh-target'
    }
    runtimeStore.getRepos = () => [remoteRepo]
    runtimeStore.getRepo = (id: string) => (id === remoteRepo.id ? remoteRepo : undefined)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const listProcesses = vi.fn(async () => [
      {
        id: remotePtyId,
        incarnationId: 'remote-incarnation',
        terminalHandle: 'term_remote',
        title: 'Remote terminal',
        cwd: '/remote/worktree',
        worktreeId: remoteWorktreeId
      }
    ])
    runtime.setPtyController({
      listProcesses,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const listWorktrees = vi.fn(() => new Promise<never>(() => {}))
    registerSshGitProvider('ssh-target', { listWorktrees } as never)

    vi.useFakeTimers()
    try {
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => resolve(null), 1_000)
      })
      const resultPromise = runtime.listMobileSessionTabs(`id:${remoteWorktreeId}`)
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(1_000)
      const result = await Promise.race([resultPromise, timeout])
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
      }

      expect(result).not.toBeNull()
      expect(listWorktrees).not.toHaveBeenCalled()
      expect(listProcesses).toHaveBeenCalledOnce()
      expect(listProcesses).toHaveBeenCalledWith(
        'ssh-target',
        expect.objectContaining({ deadlineMs: expect.any(Number) })
      )
      expect(result).toMatchObject({
        worktree: remoteWorktreeId,
        tabs: [expect.objectContaining({ type: 'terminal', parentTabId: 'remote-tab' })]
      })
    } finally {
      vi.useRealTimers()
      unregisterSshGitProvider('ssh-target')
    }
  })

  it('hydrates persisted tabs when the store cannot report repos', async () => {
    // Why: #9343 read the repo gate as `getRepos?.() ?? []`, so a store that cannot
    // report its inventory looked like "every repo is gone" and hydrated nothing —
    // every tab vanished. An unavailable list must fail open; only a list the store
    // actually returned may prune a dead repo's session key.
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const runtime = new OrcaRuntimeService({
      ...runtimeStore,
      getRepos: () => undefined
    } as never)

    const tabs = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(tabs.tabs).toEqual([
      expect.objectContaining({ type: 'terminal', parentTabId: 'host-tab' })
    ])
  })

  it('advertises browser screencast only when a renderer window is available', () => {
    const runtime = createRuntime()
    electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false } as never)

    runtime.attachWindow(TEST_WINDOW_ID)

    expect(runtime.getStatus().capabilities).toContain('browser.screencast.v1')
  })

  it('advertises safe Codex reset-credit RPC support as a static capability', () => {
    const runtime = createRuntime()

    expect(runtime.getStatus().capabilities).toContain('accounts.codex-reset-credit.v1')
  })

  it('routes mobile Codex reset consumption through the account mutation coordinator', async () => {
    const runtime = createRuntime()
    const expectedScope = {
      target: { runtime: 'host' as const, wslDistro: null },
      accountId: 'codex-account',
      accountRevision: 42,
      offerRevision: 'v1:offer'
    }
    const capturedCodex = {
      accounts: [],
      activeAccountId: expectedScope.accountId,
      activeAccountIdsByRuntime: { host: expectedScope.accountId, wsl: {} }
    }
    const capturedRateLimits = {
      codexTarget: expectedScope.target,
      marker: 'captured-before-queue-advanced'
    }
    const codexAccounts = {
      consumeRateLimitResetCredit: vi.fn().mockResolvedValue({
        outcome: 'reset',
        scope: expectedScope,
        codex: capturedCodex,
        rateLimits: capturedRateLimits
      }),
      listAccounts: vi.fn(() => ({
        accounts: [],
        activeAccountId: 'queued-next-account',
        activeAccountIdsByRuntime: { host: 'queued-next-account', wsl: {} }
      }))
    }
    const rateLimits = {
      consumeCodexRateLimitResetCredit: vi.fn(),
      getState: vi.fn(() => ({
        codexTarget: expectedScope.target,
        marker: 'after-queue-advanced'
      }))
    }
    runtime.setAccountServices({
      claudeAccounts: {
        listAccounts: vi.fn(() => ({ accounts: [], activeAccountId: null }))
      },
      codexAccounts,
      rateLimits
    } as never)

    const result = await runtime.consumeCodexRateLimitResetCredit(
      '11111111-1111-4111-8111-111111111111',
      expectedScope
    )

    expect(result).toMatchObject({
      outcome: 'reset',
      scope: expectedScope,
      snapshot: { codex: capturedCodex, rateLimits: capturedRateLimits }
    })
    expect(codexAccounts.listAccounts).not.toHaveBeenCalled()
    expect(rateLimits.getState).not.toHaveBeenCalled()
    expect(codexAccounts.consumeRateLimitResetCredit).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expectedScope
    )
    expect(rateLimits.consumeCodexRateLimitResetCredit).not.toHaveBeenCalled()
  })

  it('maps a definite pre-provider rejection into an authoritative current snapshot', async () => {
    const runtime = createRuntime()
    const expectedScope = {
      target: { runtime: 'host' as const, wslDistro: null },
      accountId: 'codex-account',
      accountRevision: 42,
      offerRevision: 'v1:stale'
    }
    const codex = {
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    }
    const rateLimitState = {
      codexTarget: expectedScope.target,
      marker: 'current-after-rejection'
    }
    runtime.setAccountServices({
      claudeAccounts: {
        listAccounts: vi.fn(() => ({ accounts: [], activeAccountId: null }))
      },
      codexAccounts: {
        consumeRateLimitResetCredit: vi.fn().mockResolvedValue({
          status: 'rejectedBeforeProvider',
          retryDisposition: 'discardAttempt',
          reason: 'offerChanged',
          scope: expectedScope,
          codex,
          rateLimits: rateLimitState
        })
      },
      rateLimits: {}
    } as never)

    await expect(
      runtime.consumeCodexRateLimitResetCredit(
        '11111111-1111-4111-8111-111111111111',
        expectedScope
      )
    ).resolves.toMatchObject({
      status: 'rejectedBeforeProvider',
      retryDisposition: 'discardAttempt',
      reason: 'offerChanged',
      scope: expectedScope,
      snapshot: { codex, rateLimits: rateLimitState }
    })
  })
})
