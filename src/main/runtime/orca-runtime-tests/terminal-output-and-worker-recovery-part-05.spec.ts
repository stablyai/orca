import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  getDefaultWorkspaceSession,
  join,
  mkdtemp,
  registerSshFilesystemProvider,
  tmpdir,
  unregisterSshFilesystemProvider
} from '../orca-runtime-test-mocks.spec'
import type { OrchestrationDb } from '../orchestration/db'
import type { WorkspaceSessionState } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  LIST_PROVIDER_DEADLINE,
  TEST_FOLDER_WORKSPACE_KEY,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  makeRuntimeStoreWithWorkspaceSession,
  store
} from '../orca-runtime-test-fixtures.spec'
import { publishLegacyWorkerReveal } from '../orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it('keeps live workers fenced without exact controller identity evidence', async () => {
    const incarnationId = '56565656-5656-4656-8656-565656565656'
    const cases = [
      {
        name: 'missing',
        leafId: '11111111-1111-4111-8111-111111111111',
        terminalHandle: 'term_missing'
      },
      {
        name: 'ambiguous',
        leafId: '22222222-2222-4222-8222-222222222222',
        terminalHandle: 'term_ambiguous'
      },
      {
        name: 'wrong-handle',
        leafId: '33333333-3333-4333-8333-333333333333',
        terminalHandle: 'term_wrong_handle'
      },
      {
        name: 'wrong-incarnation',
        leafId: '44444444-4444-4444-8444-444444444444',
        terminalHandle: 'term_wrong_incarnation'
      }
    ] as const
    const sleepingAgentSessionsByPaneKey = Object.fromEntries(
      cases.map(({ name, leafId }) => {
        const paneKey = `legacy-${name}:${leafId}`
        return [
          paneKey,
          {
            paneKey,
            tabId: `legacy-${name}`,
            worktreeId: TEST_WORKTREE_ID,
            agent: 'codex',
            providerSession: { key: 'session_id', id: `session-${name}` },
            prompt: 'continue',
            state: 'working',
            capturedAt: 1,
            updatedAt: 1,
            origin: 'live'
          }
        ]
      })
    ) as WorkspaceSessionState['sleepingAgentSessionsByPaneKey']
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(
      { ...runtimeStore, flushOrThrow: vi.fn() } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () =>
        cases.map(({ name, leafId, terminalHandle }) => ({
          dispatch_id: `dispatch-${name}`,
          task_id: `task-${name}`,
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: terminalHandle,
          assignee_pane_key: `legacy-${name}:${leafId}`,
          process_incarnation: `pty-${name}:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: terminalHandle
        }))
    } as unknown as OrchestrationDb)
    const listProcesses = vi.fn(async () => [
      {
        id: 'pty-missing',
        title: 'Missing identity',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID
      },
      {
        id: 'pty-ambiguous',
        incarnationId,
        terminalHandle: 'term_ambiguous',
        title: 'Ambiguous identity',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID
      },
      {
        id: 'pty-ambiguous-other',
        incarnationId,
        terminalHandle: 'term_ambiguous',
        title: 'Ambiguous identity duplicate',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID
      },
      {
        id: 'pty-wrong-handle',
        incarnationId,
        terminalHandle: 'term_other',
        title: 'Wrong handle',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID
      },
      {
        id: 'pty-wrong-incarnation',
        incarnationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        terminalHandle: 'term_wrong_incarnation',
        title: 'Wrong incarnation',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID
      }
    ])
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: (candidate) => candidate === 'pty-folder-legacy',
      listProcesses
    })

    await expect(runtime.reconcileLegacyWorkerTerminals()).resolves.toMatchObject({
      adoptedDispatchIds: [],
      exitedDispatchIds: ['dispatch-wrong-handle', 'dispatch-wrong-incarnation'],
      deferredDispatchIds: ['dispatch-missing', 'dispatch-ambiguous']
    })
    expect(listProcesses).toHaveBeenCalledOnce()
    expect(listProcesses).toHaveBeenCalledWith(null, LIST_PROVIDER_DEADLINE)
    for (const { name, leafId } of cases.slice(0, 2)) {
      expect(
        getSession().sleepingAgentSessionsByPaneKey?.[`legacy-${name}:${leafId}`]
          ?.automaticResumeBlockedBy
      ).toBe('legacy-orchestration-worker')
    }
    for (const { name, leafId } of cases.slice(2)) {
      expect(
        getSession().sleepingAgentSessionsByPaneKey?.[`legacy-${name}:${leafId}`]
      ).toBeUndefined()
    }
  })

  it('adopts an exact live legacy worker in a folder workspace', async () => {
    const workerPaneKey = `legacy-folder-worker:${HEADLESS_LEAF_ID}`
    const incarnationId = '66666666-6666-4666-8666-666666666666'
    const folderPath = await mkdtemp(join(tmpdir(), 'orca-legacy-worker-folder-'))
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: TEST_FOLDER_WORKSPACE_KEY,
      tabsByWorktree: { [TEST_FOLDER_WORKSPACE_KEY]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-folder-worker',
          worktreeId: TEST_FOLDER_WORKSPACE_KEY,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-folder-codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const folderWorkspace = makeFolderWorkspace({ folderPath })
    const projectGroup = makeFolderProjectGroup({ parentPath: folderPath })
    const runtime = new OrcaRuntimeService(
      {
        ...runtimeStore,
        getFolderWorkspaces: () => [folderWorkspace],
        getProjectGroups: () => [projectGroup],
        flushOrThrow: vi.fn()
      } as never,
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-folder',
          task_id: 'task-folder',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_folder',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `pty-folder-legacy:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_FOLDER_WORKSPACE_KEY,
          agent_terminal_handle: 'term_folder'
        }
      ]
    } as unknown as OrchestrationDb)
    const listProcesses = vi.fn(async () => [
      {
        id: 'pty-folder-legacy',
        incarnationId,
        terminalHandle: 'term_folder',
        title: 'Folder worker',
        cwd: folderPath,
        worktreeId: TEST_FOLDER_WORKSPACE_KEY,
        wslDistro: null
      }
    ])
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: (candidate) => candidate === 'pty-folder-legacy',
      listProcesses
    })
    const revealTerminalSession = vi.fn().mockImplementation(() =>
      publishLegacyWorkerReveal(runtime, {
        worktreeId: TEST_FOLDER_WORKSPACE_KEY,
        tabId: 'legacy-folder-worker',
        leafId: HEADLESS_LEAF_ID,
        ptyId: 'pty-folder-legacy'
      })
    )
    runtime.setNotifier({ revealTerminalSession } as never)

    await expect(
      runtime.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
    ).resolves.toMatchObject({
      adoptedDispatchIds: ['dispatch-folder'],
      exitedDispatchIds: [],
      deferredDispatchIds: []
    })
    expect(getSession().tabsByWorktree[TEST_FOLDER_WORKSPACE_KEY]).toContainEqual(
      expect.objectContaining({
        id: 'legacy-folder-worker',
        ptyId: 'pty-folder-legacy',
        worktreeId: TEST_FOLDER_WORKSPACE_KEY
      })
    )
    expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(listProcesses).toHaveBeenCalledTimes(3)
    expect(listProcesses).toHaveBeenCalledWith(null, LIST_PROVIDER_DEADLINE)
    expect(revealTerminalSession).toHaveBeenCalledWith(TEST_FOLDER_WORKSPACE_KEY, {
      ptyId: 'pty-folder-legacy',
      title: 'Folder worker',
      activate: false,
      presentation: 'background',
      tabId: 'legacy-folder-worker',
      leafId: HEADLESS_LEAF_ID,
      focus: false,
      expectedProcessIdentity: {
        terminalHandle: 'term_folder',
        incarnationId
      }
    })
  })

  it('adopts an SSH folder legacy worker through its SSH workspace-session partition', async () => {
    const connectionId = 'ssh-folder'
    const ptyId = `ssh:${connectionId}@@pty-folder-legacy`
    const workerPaneKey = `legacy-ssh-folder-worker:${HEADLESS_LEAF_ID}`
    const incarnationId = '67676767-6767-4767-8767-676767676767'
    const folderPath = '/srv/platform'
    const sshInitialSession: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: TEST_FOLDER_WORKSPACE_KEY,
      tabsByWorktree: { [TEST_FOLDER_WORKSPACE_KEY]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-ssh-folder-worker',
          worktreeId: TEST_FOLDER_WORKSPACE_KEY,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-ssh-folder-codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live',
          connectionId
        }
      }
    }
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(sshInitialSession)
    const localSession = getDefaultWorkspaceSession()
    let sshSession = sshInitialSession
    const getWorkspaceSession = vi.fn((hostId?: string | null) =>
      hostId === `ssh:${connectionId}` ? sshSession : localSession
    )
    const setWorkspaceSession = vi.fn((next: WorkspaceSessionState, hostId?: string | null) => {
      if (hostId !== `ssh:${connectionId}`) {
        throw new Error(`unexpected workspace-session host ${hostId ?? 'default'}`)
      }
      sshSession = next
    })
    const folderWorkspace = makeFolderWorkspace({ folderPath, connectionId })
    const projectGroup = makeFolderProjectGroup({ parentPath: folderPath })
    const runtime = new OrcaRuntimeService(
      {
        ...runtimeStore,
        getFolderWorkspaces: () => [folderWorkspace],
        getProjectGroups: () => [projectGroup],
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
          dispatch_id: 'dispatch-ssh-folder',
          task_id: 'task-ssh-folder',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_ssh_folder',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `${ptyId}:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_FOLDER_WORKSPACE_KEY,
          agent_terminal_handle: 'term_ssh_folder'
        }
      ]
    } as unknown as OrchestrationDb)
    const listProcesses = vi.fn(async () => [
      {
        id: ptyId,
        incarnationId,
        terminalHandle: 'term_ssh_folder',
        title: 'SSH folder worker',
        cwd: folderPath,
        worktreeId: TEST_FOLDER_WORKSPACE_KEY,
        wslDistro: null
      }
    ])
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: (candidate) => candidate === ptyId,
      listProcesses
    })
    const revealTerminalSession = vi.fn().mockImplementation(() =>
      publishLegacyWorkerReveal(runtime, {
        worktreeId: TEST_FOLDER_WORKSPACE_KEY,
        tabId: 'legacy-ssh-folder-worker',
        leafId: HEADLESS_LEAF_ID,
        ptyId
      })
    )
    runtime.setNotifier({ revealTerminalSession } as never)
    registerSshFilesystemProvider(connectionId, {
      stat: vi.fn(async () => ({ size: 0, type: 'directory', mtime: 1 }))
    } as never)

    try {
      expect(runtime.prepareLegacyWorkerTerminalRecovery()).toMatchObject({
        blockedPanes: [expect.objectContaining({ paneKey: workerPaneKey })]
      })
      expect(
        sshSession.sleepingAgentSessionsByPaneKey?.[workerPaneKey]?.automaticResumeBlockedBy
      ).toBe('legacy-orchestration-worker')
      expect(localSession.sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
      await expect(
        runtime.reconcileLegacyWorkerTerminals({
          connectionId,
          materializeRenderer: true
        })
      ).resolves.toMatchObject({
        adoptedDispatchIds: ['dispatch-ssh-folder'],
        exitedDispatchIds: [],
        deferredDispatchIds: []
      })
    } finally {
      unregisterSshFilesystemProvider(connectionId)
    }

    expect(sshSession.sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(localSession.sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(getWorkspaceSession).toHaveBeenCalledWith(`ssh:${connectionId}`)
    expect(setWorkspaceSession).toHaveBeenCalledWith(expect.any(Object), `ssh:${connectionId}`)
    expect(listProcesses).toHaveBeenCalledTimes(3)
    expect(listProcesses).toHaveBeenCalledWith(connectionId, LIST_PROVIDER_DEADLINE)
    expect(sshSession.tabsByWorktree[TEST_FOLDER_WORKSPACE_KEY]).toContainEqual(
      expect.objectContaining({
        id: 'legacy-ssh-folder-worker',
        ptyId,
        worktreeId: TEST_FOLDER_WORKSPACE_KEY
      })
    )
    expect(revealTerminalSession).toHaveBeenCalledWith(TEST_FOLDER_WORKSPACE_KEY, {
      ptyId,
      title: 'SSH folder worker',
      activate: false,
      presentation: 'background',
      tabId: 'legacy-ssh-folder-worker',
      leafId: HEADLESS_LEAF_ID,
      focus: false,
      expectedProcessIdentity: {
        terminalHandle: 'term_ssh_folder',
        incarnationId
      }
    })
  })

  it('fences an unresolved folder legacy worker in its exact retained session partition', () => {
    const connectionId = 'ssh-unresolved-folder'
    const worktreeId = 'folder:missing-folder'
    const workerPaneKey = `legacy-unresolved-folder-worker:${HEADLESS_LEAF_ID}`
    const remoteInitialSession: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [worktreeId]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-unresolved-folder-worker',
          worktreeId,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-unresolved-folder-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live',
          connectionId
        }
      }
    }
    const localSession = getDefaultWorkspaceSession()
    let remoteSession = remoteInitialSession
    const getWorkspaceSession = vi.fn((hostId?: string | null) =>
      hostId === `ssh:${connectionId}` ? remoteSession : localSession
    )
    const setWorkspaceSession = vi.fn((next: WorkspaceSessionState, hostId?: string | null) => {
      if (hostId !== `ssh:${connectionId}`) {
        throw new Error(`unexpected workspace-session host ${hostId ?? 'default'}`)
      }
      remoteSession = next
    })
    const runtime = new OrcaRuntimeService({
      ...store,
      getFolderWorkspaces: () => [],
      getWorkspaceSession,
      getWorkspaceSessionHostIds: () => ['local', `ssh:${connectionId}`],
      setWorkspaceSession,
      flushOrThrow: vi.fn()
    } as never)
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-unresolved-folder',
          task_id: 'task-unresolved-folder',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_unresolved_folder',
          assignee_pane_key: workerPaneKey,
          process_incarnation: 'pty-unresolved-folder:68686868-6868-4868-8868-686868686868',
          worker_state: 'ready',
          worktree_id: worktreeId,
          agent_terminal_handle: 'term_unresolved_folder'
        }
      ]
    } as unknown as OrchestrationDb)

    expect(runtime.prepareLegacyWorkerTerminalRecovery()).toMatchObject({
      blockedPanes: [expect.objectContaining({ paneKey: workerPaneKey, worktreeId })]
    })
    expect(
      remoteSession.sleepingAgentSessionsByPaneKey?.[workerPaneKey]?.automaticResumeBlockedBy
    ).toBe('legacy-orchestration-worker')
    expect(localSession.sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
    expect(setWorkspaceSession).toHaveBeenCalledOnce()
    expect(setWorkspaceSession).toHaveBeenCalledWith(expect.any(Object), `ssh:${connectionId}`)
  })
})
