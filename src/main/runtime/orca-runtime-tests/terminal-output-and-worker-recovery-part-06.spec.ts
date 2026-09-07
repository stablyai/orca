import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  getDefaultWorkspaceSession,
  registerSshGitProvider,
  setPlatform,
  unregisterSshGitProvider
} from '../orca-runtime-test-mocks.spec'
import type { OrchestrationDb } from '../orchestration/db'
import type { WorkspaceSessionState } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  HEADLESS_THIRD_LEAF_ID,
  LIST_PROVIDER_DEADLINE,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from '../orca-runtime-test-fixtures.spec'
import { publishLegacyWorkerReveal } from '../orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it('adopts an SSH legacy worker only after its matching relay is ready', async () => {
    const connectionId = 'ssh-legacy-worker'
    const ptyId = `ssh:${connectionId}@@pty-legacy-worker`
    const workerPaneKey = `legacy-ssh-worker:${HEADLESS_LEAF_ID}`
    const incarnationId = '77777777-7777-4777-8777-777777777777'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-ssh-worker',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-ssh-codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live',
          connectionId
        }
      }
    }
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const localSession = getDefaultWorkspaceSession()
    let sshSession = session
    const getWorkspaceSession = vi.fn((hostId?: string | null) =>
      hostId === `ssh:${connectionId}` ? sshSession : localSession
    )
    const setWorkspaceSession = vi.fn((next: WorkspaceSessionState, hostId?: string | null) => {
      if (hostId !== `ssh:${connectionId}`) {
        throw new Error(`unexpected workspace-session host ${hostId ?? 'default'}`)
      }
      sshSession = next
    })
    const getSession = (): WorkspaceSessionState => sshSession
    const remoteRepo = {
      ...store.getRepos()[0],
      connectionId
    }
    const listProcesses = vi.fn(async () => [
      {
        id: ptyId,
        incarnationId,
        terminalHandle: 'term_ssh_legacy',
        title: 'SSH legacy worker',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID,
        wslDistro: null
      }
    ])
    const serializeProviderBuffer = vi.fn().mockResolvedValue(null)
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: ' >_ OpenAI Codex (v0.131.0)\r\n model:       gpt-5.5 high\r\n directory:   /repo\r\n',
      cols: 80,
      rows: 24
    })
    const runtime = new OrcaRuntimeService(
      {
        ...runtimeStore,
        getRepos: () => [remoteRepo],
        getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
        getWorkspaceSession,
        setWorkspaceSession,
        flushOrThrow: vi.fn()
      } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-ssh',
          task_id: 'task-ssh',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_ssh_legacy',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `${ptyId}:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_ssh_legacy'
        }
      ]
    } as unknown as OrchestrationDb)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: (candidate) => candidate === ptyId,
      listProcesses,
      serializeBuffer,
      serializeProviderBuffer,
      hasRendererSerializer: () => true
    })
    const revealTerminalSession = vi.fn().mockImplementation(() =>
      publishLegacyWorkerReveal(runtime, {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'legacy-ssh-worker',
        leafId: HEADLESS_LEAF_ID,
        ptyId
      })
    )
    runtime.setNotifier({ revealTerminalSession } as never)
    registerSshGitProvider(connectionId, {
      listWorktrees: vi.fn(async () => [
        {
          path: TEST_WORKTREE_PATH,
          head: 'abc',
          branch: 'main',
          isBare: false,
          isMainWorktree: false
        }
      ])
    } as never)

    try {
      await expect(
        runtime.reconcileLegacyWorkerTerminals({
          connectionId: 'ssh-wrong-host',
          materializeRenderer: true
        })
      ).resolves.toMatchObject({
        adoptedDispatchIds: [],
        exitedDispatchIds: [],
        deferredDispatchIds: ['dispatch-ssh']
      })
      expect(listProcesses).not.toHaveBeenCalled()
      expect(
        getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]?.automaticResumeBlockedBy
      ).toBe('legacy-orchestration-worker')
      expect(localSession.sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
      expect(getWorkspaceSession).toHaveBeenCalledWith(`ssh:${connectionId}`)

      await expect(
        runtime.reconcileLegacyWorkerTerminals({
          connectionId,
          materializeRenderer: true
        })
      ).resolves.toMatchObject({
        adoptedDispatchIds: ['dispatch-ssh'],
        exitedDispatchIds: [],
        deferredDispatchIds: []
      })
      expect(listProcesses).toHaveBeenLastCalledWith(connectionId, LIST_PROVIDER_DEADLINE)
    } finally {
      unregisterSshGitProvider(connectionId)
    }

    expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(setWorkspaceSession).toHaveBeenCalledWith(expect.any(Object), `ssh:${connectionId}`)
    expect(listProcesses).toHaveBeenCalledTimes(3)
    expect(revealTerminalSession).toHaveBeenCalledWith(TEST_WORKTREE_ID, {
      ptyId,
      title: 'SSH legacy worker',
      activate: false,
      presentation: 'background',
      tabId: 'legacy-ssh-worker',
      leafId: HEADLESS_LEAF_ID,
      focus: false,
      expectedProcessIdentity: {
        terminalHandle: 'term_ssh_legacy',
        incarnationId
      }
    })
    await expect(
      runtime.waitForTerminal('term_ssh_legacy', { condition: 'tui-idle', timeoutMs: 100 })
    ).resolves.toMatchObject({ satisfied: true })
    expect(serializeProviderBuffer).toHaveBeenCalledOnce()
    expect(serializeBuffer).toHaveBeenCalledOnce()
  })

  it('refuses a cross-distro WSL worker and adopts it after exact host ownership matches', async () => {
    setPlatform('win32')
    const workerPaneKey = `legacy-wsl-worker:${HEADLESS_LEAF_ID}`
    const incarnationId = '88888888-8888-4888-8888-888888888888'
    let observedDistro = 'Debian'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-wsl-worker',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-wsl-codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(
      {
        ...runtimeStore,
        getProjects: () => [
          {
            id: 'project-wsl',
            displayName: 'repo',
            badgeColor: 'blue',
            sourceRepoIds: [TEST_REPO_ID],
            localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
            createdAt: 0,
            updatedAt: 0
          }
        ],
        getSettings: () => ({
          ...store.getSettings(),
          localWindowsRuntimeDefault: { kind: 'windows-host' }
        }),
        flushOrThrow: vi.fn()
      } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-wsl',
          task_id: 'task-wsl',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_wsl_legacy',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `pty-wsl-legacy:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_wsl_legacy'
        }
      ]
    } as unknown as OrchestrationDb)
    // Declares the scope parameter so mock.calls keeps it — the runtime passes a deadline
    // alongside it, and a bare `async () =>` would type the call tuple as empty.
    const listProcesses = vi.fn(async (_connectionId?: string | null) => [
      {
        id: 'pty-wsl-legacy',
        incarnationId,
        terminalHandle: 'term_wsl_legacy',
        title: 'WSL legacy worker',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID,
        wslDistro: observedDistro
      }
    ])
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: (ptyId) => ptyId === 'pty-wsl-legacy',
      listProcesses
    })
    const revealTerminalSession = vi.fn().mockImplementation(() =>
      publishLegacyWorkerReveal(runtime, {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'legacy-wsl-worker',
        leafId: HEADLESS_LEAF_ID,
        ptyId: 'pty-wsl-legacy'
      })
    )
    runtime.setNotifier({ revealTerminalSession } as never)

    await expect(
      runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    ).resolves.toMatchObject({
      adoptedDispatchIds: [],
      exitedDispatchIds: [],
      deferredDispatchIds: ['dispatch-wsl']
    })
    expect(
      getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]?.automaticResumeBlockedBy
    ).toBe('legacy-orchestration-worker')
    expect(revealTerminalSession).not.toHaveBeenCalled()

    observedDistro = 'Ubuntu'
    await expect(
      runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    ).resolves.toMatchObject({
      adoptedDispatchIds: ['dispatch-wsl'],
      exitedDispatchIds: [],
      deferredDispatchIds: []
    })
    expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(revealTerminalSession).toHaveBeenCalledOnce()
    expect(listProcesses).toHaveBeenCalledTimes(5)
    expect(listProcesses.mock.calls.map((call) => call[0])).toEqual([null, null, null, null, null])
  })

  it('restores orphan pane and group topology without replacing a newer host-owned tab', async () => {
    const session: WorkspaceSessionState = {
      ...makeWorkspaceSessionWithHeadlessTerminal({
        activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'terminal-3' },
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'terminal-3',
              ptyId: 'pty-new',
              worktreeId: TEST_WORKTREE_ID,
              title: 'Terminal 3',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 3
            }
          ]
        },
        terminalLayoutsByTabId: {
          'terminal-3': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'pty-new' })
        }
      }),
      tabGroups: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'group-live',
            worktreeId: TEST_WORKTREE_ID,
            activeTabId: 'terminal-3',
            tabOrder: ['terminal-3']
          }
        ]
      },
      tabGroupLayouts: {
        [TEST_WORKTREE_ID]: { type: 'leaf', groupId: 'group-live' }
      },
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-live' },
      terminalPtyIncarnationsByPaneKey: {
        [`terminal-3:${HEADLESS_LEAF_ID}`]: 'inc-new'
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-new',
          incarnationId: 'inc-new',
          terminalHandle: 'term_new',
          title: 'Terminal 3',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        },
        {
          id: 'pty-agent',
          incarnationId: 'inc-agent',
          terminalHandle: 'term_agent',
          title: 'Claude',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        },
        {
          id: 'pty-setup',
          incarnationId: 'inc-setup',
          terminalHandle: 'term_setup',
          title: 'Setup',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        },
        {
          id: 'pty-shell',
          incarnationId: 'inc-shell',
          terminalHandle: 'term_shell',
          title: 'Shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })

    const adopted = await runtime.adoptTerminalOrphans({
      worktree: `id:${TEST_WORKTREE_ID}`,
      expectedTopologyRevision: 0,
      activeTabId: 'tab-shell',
      activeGroupId: 'group-old-right',
      claims: [
        {
          terminal: 'term_agent',
          ptyId: 'pty-agent',
          incarnationId: 'inc-agent',
          tabId: 'tab-agent',
          leafId: HEADLESS_LEAF_ID
        },
        {
          terminal: 'term_setup',
          ptyId: 'pty-setup',
          incarnationId: 'inc-setup',
          tabId: 'tab-agent',
          leafId: HEADLESS_SECOND_LEAF_ID
        },
        {
          terminal: 'term_shell',
          ptyId: 'pty-shell',
          incarnationId: 'inc-shell',
          tabId: 'tab-shell',
          leafId: HEADLESS_THIRD_LEAF_ID
        }
      ],
      topology: {
        tabs: [
          {
            tabId: 'tab-agent',
            root: {
              type: 'split',
              direction: 'horizontal',
              ratio: 0.7,
              first: { type: 'leaf', leafId: HEADLESS_LEAF_ID },
              second: { type: 'leaf', leafId: HEADLESS_SECOND_LEAF_ID }
            },
            activeLeafId: HEADLESS_SECOND_LEAF_ID,
            expandedLeafId: null
          },
          {
            tabId: 'tab-shell',
            root: { type: 'leaf', leafId: HEADLESS_THIRD_LEAF_ID },
            activeLeafId: HEADLESS_THIRD_LEAF_ID,
            expandedLeafId: HEADLESS_THIRD_LEAF_ID
          }
        ],
        groups: [
          {
            id: 'group-old-left',
            activeTabId: 'tab-agent',
            tabOrder: ['tab-agent'],
            recentTabIds: ['tab-agent']
          },
          {
            id: 'group-old-right',
            activeTabId: 'tab-shell',
            tabOrder: ['tab-shell']
          }
        ],
        groupLayout: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.6,
          first: { type: 'leaf', groupId: 'group-old-left' },
          second: { type: 'leaf', groupId: 'group-old-right' }
        }
      }
    })

    expect(adopted.snapshot.activeGroupId).toBe('group-old-right')
    expect(adopted.snapshot.activeTabId).toBe(`tab-shell::${HEADLESS_THIRD_LEAF_ID}`)
    expect(adopted.snapshot.tabGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'group-live', tabOrder: ['terminal-3'] }),
        expect.objectContaining({ id: 'group-old-left', tabOrder: ['tab-agent'] }),
        expect.objectContaining({ id: 'group-old-right', tabOrder: ['tab-shell'] })
      ])
    )
    expect(adopted.snapshot.tabGroupLayout).toMatchObject({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', groupId: 'group-live' },
      second: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.6,
        first: { type: 'leaf', groupId: 'group-old-left' },
        second: { type: 'leaf', groupId: 'group-old-right' }
      }
    })
    expect(getSession().terminalLayoutsByTabId['tab-agent']).toMatchObject({
      root: { type: 'split', direction: 'horizontal', ratio: 0.7 },
      activeLeafId: HEADLESS_SECOND_LEAF_ID,
      ptyIdsByLeafId: {
        [HEADLESS_LEAF_ID]: 'pty-agent',
        [HEADLESS_SECOND_LEAF_ID]: 'pty-setup'
      }
    })
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID].map((tab) => tab.id)).toEqual([
      'terminal-3',
      'tab-agent',
      'tab-shell'
    ])
  })

  it('canonicalizes an equivalent persisted worktree key without duplicating terminal topology', async () => {
    const aliasWorktreeId = `${TEST_REPO_ID}::/tmp//worktree-a/`
    const base = makeWorkspaceSessionWithHeadlessTerminal({
      terminalPtyIncarnationsByPaneKey: {
        [`host-tab:${HEADLESS_LEAF_ID}`]: 'inc-alias'
      }
    })
    const session: WorkspaceSessionState = {
      ...base,
      activeTabIdByWorktree: { [aliasWorktreeId]: 'host-tab' },
      tabsByWorktree: {
        [aliasWorktreeId]: base.tabsByWorktree[TEST_WORKTREE_ID]!.map((tab) => ({
          ...tab,
          worktreeId: aliasWorktreeId
        }))
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'persisted-pty',
          incarnationId: 'inc-alias',
          terminalHandle: 'term_alias',
          title: 'Alias shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })

    const adopted = await runtime.adoptTerminalOrphans({
      worktree: `id:${TEST_WORKTREE_ID}`,
      expectedTopologyRevision: 0,
      claims: [
        {
          terminal: 'term_alias',
          ptyId: 'persisted-pty',
          incarnationId: 'inc-alias',
          tabId: 'host-tab',
          leafId: HEADLESS_LEAF_ID
        }
      ]
    })

    expect(adopted).toMatchObject({ adopted: true, topologyRevision: 1 })
    expect(adopted.snapshot.worktree).toBe(TEST_WORKTREE_ID)
    expect(Object.keys(getSession().tabsByWorktree)).toContain(TEST_WORKTREE_ID)
    expect(Object.keys(getSession().tabsByWorktree)).not.toContain(aliasWorktreeId)
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]?.[0]?.worktreeId).toBe(TEST_WORKTREE_ID)
    expect(getSession().activeTabIdByWorktree).toEqual({ [TEST_WORKTREE_ID]: 'host-tab' })
  })
})
