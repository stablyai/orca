import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  OrcaRuntimeService,
  detectInstalledAgentsWithShellPathHydrationMock
} from '../../orca-runtime-test-mocks.spec'
import {
  makeFolderWorkspace,
  makeFolderProjectGroup,
  makeWorktreeMeta,
  store
} from '../../orca-runtime-test-fixtures.spec'
import { RpcDispatcher } from '../dispatcher'
import { PREFLIGHT_METHODS } from './preflight'
import type { Repo } from '../../../../shared/repo-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { PREFLIGHT_RUNTIME_CAPABILITIES } from '../../../../shared/preflight-runtime-capabilities'
import { launchHeadlessAutomationAgent } from '../../../automations/headless-automation-agent-launch'
import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import { bindPaneFirst } from '../../bind-first-pane.test-fixture'
import {
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore
} from '../../agent-session/records/agent-session-record-store-test-harness'
import { closeTestJournalHostDatabase } from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import { readAutomationRunReceipt } from '../../../automations/automation-run-receipt'
import { resolveWindowsAgentForegroundProcessWithAvailability } from '../../../providers/windows-agent-foreground-process'
import { resolveStableForegroundProcess } from '../../../providers/stable-foreground-process'
import { launchAgentOnHost } from './agent-launch'
import {
  AUTOMATION_AGENT_CALLER,
  automationRunOperationId
} from '../../../automations/automation-run-operation'
import { rpcCallerOperationKey } from '../rpc-caller-identity'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { _internals as hookListener } from '../../../agent-hooks/server'
import type * as WorkspaceAgentDetection from '../../../preflight/workspace-agent-detection'
import type * as WindowsForegroundProcessRows from '../../../providers/windows-foreground-process-rows'

const { refresh } = vi.hoisted(() => ({
  refresh: vi.fn(async () => ({
    agents: ['codex'],
    addedPathSegments: [],
    shellHydrationOk: true,
    pathSource: 'shell_hydrate',
    pathFailureReason: 'none'
  }))
}))
// These ownership cases use a running distro; the stopped-distro contract is separate.
vi.mock('../../../wsl/discovery/wsl-background-exec-gate', () => ({
  assertWslDistroRunningForExec: async () => {},
  runAsWslExecUserAct: async (_distro: unknown, act: () => Promise<unknown>) => act()
}))
vi.mock('../../../preflight/workspace-agent-detection', async (original) => ({
  ...(await original<typeof WorkspaceAgentDetection>()),
  refreshAgentsOnHost: refresh
}))

vi.mock('../../../providers/windows-foreground-process-rows', async (original) => ({
  ...(await original<typeof WindowsForegroundProcessRows>()),
  queryWindowsPaneProcessInventory: vi.fn(async () => null)
}))

const platform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('qualified discovery at the runtime RPC boundary', () => {
  it.each(['ssh', 'windows-codex', 'windows-claude', 'windows-codex-unverified'] as const)(
    'reuses the exact saved folder once under %s uncertainty and refuses missing selection',
    async (scenario) => {
      const windows = scenario !== 'ssh'
      const agent = scenario.startsWith('windows-codex') ? 'codex' : 'claude'
      const connectionId = windows ? null : 'a/b'
      const hostId = windows ? 'local' : 'ssh:a%2Fb'
      const row: AgentStatusIpcPayload = {
        paneKey: '',
        terminalHandle: '',
        agentType: agent,
        state: 'done',
        prompt: '',
        receivedAt: Date.now(),
        connectionId: null
      }
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.UTC(2026, 10, 3))
      const directory = await mkdtemp(join(tmpdir(), 'pr-33492-selected-folder-'))
      onTestFinished(async () => {
        await closeTestJournalHostDatabase(directory)
        await rm(directory, { recursive: true, force: true })
      })
      const records = await openTestAgentSessionRecordStore(directory)
      expect((await readPersistedTestAgentSessionStore(directory)).operations).toEqual({})

      const folder = makeFolderWorkspace({
        id: 'dup',
        folderPath: '/unserved/remote',
        executionHostId: hostId
      })
      const folders = [folder]
      const repo: Repo = {
        ...store.getRepos()[0]!,
        id: 'repo-1',
        path: '/unserved/remote',
        connectionId
      }
      const runtime = new OrcaRuntimeService(
        {
          ...store,
          getFolderWorkspaces: () => folders,
          getProjectGroups: () => [makeFolderProjectGroup()],
          getRepos: () => [repo],
          getRepo: () => repo
        },
        undefined,
        { getAgentStatusSnapshot: () => (windows ? [row] : []) }
      )
      vi.spyOn(runtime, 'openAgentSessionRecordStore').mockResolvedValue(records)
      vi.spyOn(runtime, 'openedAgentSessionRecordStore').mockReturnValue(records)
      const writes: { ptyId: string; data: string }[] = []
      runtime.setPtyController({
        write: (ptyId, data) => {
          writes.push({ ptyId, data })
          // Controlled PTY render acknowledgement; the launch receipt comes from the real writer.
          runtime.onPtyData(ptyId, '› draft\n\x1b[?25h', Date.now())
          return true
        },
        kill: () => true,
        getForegroundProcess: async () =>
          windows
            ? resolveStableForegroundProcess(
                await resolveWindowsAgentForegroundProcessWithAvailability(424242, 'pwsh.exe', {}),
                null
              ).processName
            : 'claude',
        confirmShellForeground: async () => false
      })
      const ptyId = 'selected-folder-live'
      const tabId = '11111111-1111-4111-8111-111111111111'
      const leafId = '22222222-2222-4222-8222-222222222222'
      const paneKey = `${tabId}:${leafId}`
      const incarnationId = 'selected-folder-incarnation'
      const handle = runtime.preAllocateHandleForPty(ptyId)
      bindPaneFirst(runtime, { worktreeId: 'folder:dup', tabId, leafId, ptyId }, hostId)
      runtime.registerPty(ptyId, 'folder:dup', connectionId, { tabId, leafId, incarnationId })
      expect(runtime.getTerminalHandleForPaneKey(paneKey)).toBe(handle)
      expect(runtime.getTerminalPtyIdForHandle(handle)).toBe(ptyId)
      expect(runtime.getPtyExecutionHostMetadata(ptyId)).toMatchObject({
        executionHostId: hostId,
        incarnationId
      })
      row.paneKey = paneKey
      row.terminalHandle = handle
      runtime.onPtyData(ptyId, '\x1b]0;workspace-alpha\x07Task finished.\r\n', Date.now())
      if (windows) {
        Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      }
      expect(await runtime.isTerminalRunningAgent(handle)).toBe(!windows)
      const presence = vi.spyOn(runtime, 'isTerminalRunningAgent')
      const create = vi.spyOn(runtime, 'createTerminal')
      const automation: Automation = {
        id: 'saved-folder',
        name: 'Saved folder',
        prompt: 'Continue review',
        agentId: agent,
        projectId: repo.id,
        workspaceMode: 'existing',
        workspaceId: 'folder:dup',
        reuseSession: true,
        precheck: null,
        baseBranch: null,
        executionTargetType: windows ? 'local' : 'ssh',
        executionTargetId: windows ? 'local' : 'a/b',
        schedulerOwner: windows ? 'local_host_service' : 'ssh_bridge',
        timezone: 'UTC',
        rrule: '0 9 * * *',
        dtstart: 1,
        enabled: false,
        nextRunAt: 2,
        missedRunPolicy: 'run_once_within_grace',
        missedRunGraceMinutes: 720,
        createdAt: 1,
        updatedAt: 1
      }
      const previous: AutomationRun = {
        id: 'old',
        automationId: automation.id,
        title: 'Saved folder',
        status: 'completed',
        trigger: 'scheduled',
        scheduledFor: 1,
        createdAt: 1,
        startedAt: 1,
        dispatchedAt: 1,
        workspaceId: 'folder:dup',
        sessionKind: 'terminal',
        chatSessionId: null,
        terminalSessionId: tabId,
        terminalPaneKey: paneKey,
        terminalPtyId: ptyId,
        outputSnapshot: null,
        precheckResult: null,
        usage: null,
        error: null
      }
      const request = {
        automation,
        run: {
          id: 'current',
          title: 'Current',
          createdAt: Date.now(),
          scheduledFor: 2,
          trigger: 'scheduled' as const
        },
        target: { ok: true as const, repo, cwd: repo.path },
        runs: [previous]
      }
      await expect(runtime.showTerminalWorkspaceLaunchScope('id:folder:dup')).rejects.toThrow(
        windows ? 'folder_workspace_path_missing' : 'folder_workspace_path_unavailable'
      )
      await expect(launchHeadlessAutomationAgent(runtime, request)).resolves.toMatchObject({
        terminalHandle: handle,
        workspaceId: 'folder:dup'
      })
      expect(writes.map((write) => write.ptyId)).toEqual([ptyId, ptyId])
      expect(writes.map((write) => write.data)).toEqual([
        `\x1b[200~${automation.prompt}\x1b[201~`,
        '\r'
      ])
      expect(readAutomationRunReceipt(records, request.run)).toMatchObject({
        kind: 'terminal',
        accepted: true,
        launch: {
          worktreeId: 'folder:dup',
          outcome: { kind: 'terminal', handle },
          prompt: { outcome: 'handed-to-terminal' }
        }
      })
      expect(create).not.toHaveBeenCalled()
      await expect(launchHeadlessAutomationAgent(runtime, request)).resolves.toMatchObject({
        terminalHandle: handle,
        workspaceId: 'folder:dup'
      })
      expect(writes).toHaveLength(2)
      expect(presence).not.toHaveBeenCalled()
      if (windows) {
        await expect(
          launchAgentOnHost(
            {
              agent,
              operationId: automationRunOperationId(
                { id: 'default-identity-control', createdAt: request.run.createdAt },
                'reuse-send'
              ),
              target: { kind: 'existing', worktree: 'id:folder:dup' },
              surface: 'terminal',
              reuseTerminal: { handle },
              prompt: { text: automation.prompt, delivery: 'submit' }
            },
            { runtime, caller: AUTOMATION_AGENT_CALLER }
          )
        ).rejects.toThrow('agent_launch_terminal_not_running_agent')
        expect(presence).toHaveResolvedWith(false)
        presence.mockClear()
        expect(writes).toHaveLength(2)
        row.state = 'working'
        if (agent === 'claude') {
          hookListener.resetCachesForTests()
          const captured: { scenario: string; t: number; payload?: Record<string, unknown> }[] =
            readFileSync(
              join(
                __dirname,
                '../../../../shared/__fixtures__/claude-task-notification-hooks.jsonl'
              ),
              'utf8'
            )
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line))
          for (const record of captured) {
            if (record.scenario === 'monitor-events' && record.t <= 6.882 && record.payload) {
              const monitor = hookListener.normalizeHookPayload(
                'claude',
                { paneKey, payload: record.payload },
                'production'
              )
              if (monitor) {
                Object.assign(row, monitor.payload, {
                  claudeRunningNonAgentTask: monitor.claudeRunningNonAgentTask
                })
              }
            }
          }
          expect(row.claudeRunningNonAgentTask).toBe(true)
        }
        const busy = { ...request, run: { ...request.run, id: 'busy-current' } }
        await expect(launchHeadlessAutomationAgent(runtime, busy)).resolves.toMatchObject({
          terminalHandle: handle
        })
        await launchHeadlessAutomationAgent(runtime, busy)
        expect(readAutomationRunReceipt(records, busy.run)).toMatchObject({
          kind: 'terminal',
          accepted: true
        })
        expect(writes.map((write) => write.ptyId)).toEqual(Array(4).fill(ptyId))
        expect(writes.filter((write) => write.data === '\r')).toHaveLength(2)
        expect(presence).not.toHaveBeenCalled()
        expect(create).not.toHaveBeenCalled()
        await expect(
          launchAgentOnHost(
            {
              agent,
              target: { kind: 'existing', worktree: 'id:folder:dup' },
              surface: 'terminal',
              reuseTerminal: { handle },
              prompt: { text: automation.prompt, delivery: 'submit' }
            },
            { runtime, caller: AUTOMATION_AGENT_CALLER },
            { allowBusy: true, unprovableHost: 'write-unless-shell' }
          )
        ).resolves.toMatchObject({ prompt: { outcome: 'handed-to-terminal' } })
        expect(presence).not.toHaveBeenCalled()
        expect(writes.filter((write) => write.data === '\r')).toHaveLength(3)
      }
      const writeCount = writes.length
      const beforeMissing = await readPersistedTestAgentSessionStore(directory)
      folders.splice(folders.indexOf(folder), 1)
      await expect(
        runtime.resolveManagedTerminalWorkspaceTarget('id:folder:dup', hostId, false)
      ).rejects.toThrow('selector_not_found')
      await expect(
        launchHeadlessAutomationAgent(runtime, {
          ...request,
          run: { ...request.run, id: 'missing-selected' }
        })
      ).rejects.toThrow('could not confirm')
      expect(await readPersistedTestAgentSessionStore(directory)).toEqual(beforeMissing)
      expect(writes).toHaveLength(writeCount)
      expect(create).not.toHaveBeenCalled()
      if (windows) {
        // A certified exit is zero effect; disconnected/unknown alone is not that proof.
        folders.push(folder)
        folder.folderPath = directory
        repo.path = directory
        if (scenario === 'windows-codex-unverified') {
          await runtime.onPtyExit(ptyId, -1, incarnationId, {
            cause: { kind: 'unknown', reason: 'stop_unverified' }
          })
          const uncertain = { ...request, run: { ...request.run, id: 'unverified-current' } }
          await expect(launchHeadlessAutomationAgent(runtime, uncertain)).rejects.toThrow(
            'could not confirm'
          )
          const callerKey = rpcCallerOperationKey(AUTOMATION_AGENT_CALLER)
          expect(
            records.getOperationRow(
              callerKey,
              automationRunOperationId(uncertain.run, 'reuse-send')
            )?.outcome.status
          ).toBe('succeeded')
          expect(readAutomationRunReceipt(records, uncertain.run)).toMatchObject({
            kind: 'terminal',
            accepted: false
          })
          expect(
            records.getOperationRow(
              callerKey,
              automationRunOperationId(uncertain.run, 'fresh-launch')
            )
          ).toBeNull()
          expect(create).not.toHaveBeenCalled()
          expect(writes).toHaveLength(writeCount)
          return
        }
        await runtime.onPtyExit(ptyId, 0, incarnationId, { cause: { kind: 'exited', exitCode: 0 } })
        create.mockRejectedValue(new Error('controlled_fresh_spawn_failure'))
        const exited = { ...request, run: { ...request.run, id: 'exited-current' } }
        await expect(launchHeadlessAutomationAgent(runtime, exited)).rejects.toThrow()
        const callerKey = rpcCallerOperationKey(AUTOMATION_AGENT_CALLER)
        expect(
          records.getOperationRow(callerKey, automationRunOperationId(exited.run, 'reuse-send'))
            ?.outcome
        ).toMatchObject({ status: 'failed', code: 'agent_launch_terminal_not_running_agent' })
        expect(
          records.getOperationRow(callerKey, automationRunOperationId(exited.run, 'fresh-launch'))
            ?.outcome
        ).toMatchObject({ status: 'failed', code: 'controlled_fresh_spawn_failure' })
        expect(create).toHaveBeenCalledOnce()
        await expect(launchHeadlessAutomationAgent(runtime, exited)).rejects.toThrow()
        expect(create).toHaveBeenCalledOnce()
        expect(writes).toHaveLength(writeCount)
      }
    }
  )

  it.each([false, true])(
    'retains the selected folder through path validation, startup and actual create (reverse=%s)',
    async (reverse) => {
      const path = await mkdtemp(join(tmpdir(), 'pr-31617-qualified-folder-'))
      try {
        const local = makeFolderWorkspace({ id: 'dup', folderPath: path, executionHostId: 'local' })
        const remote = {
          ...local,
          folderPath: '/unserved/remote',
          executionHostId: 'ssh:a%2Fb' as const
        }
        const folders = reverse ? [remote, local] : [local, remote]
        const runtime = new OrcaRuntimeService({
          ...store,
          getFolderWorkspaces: () => folders,
          getProjectGroups: () => [makeFolderProjectGroup()],
          getRepos: () => []
        })
        const spawn = vi.fn(async () => ({ id: 'pty-selected-folder' }))
        runtime.setPtyController({
          spawn,
          write: () => true,
          kill: () => true,
          getForegroundProcess: async () => null
        })
        const startup = vi.fn(() => ({
          agent: 'codex',
          startup: { command: 'codex', env: {}, startupCommandDelivery: 'none', telemetry: {} }
        }))
        Object.defineProperty(runtime, 'buildStartupForAgent', { value: startup })
        const selected = await runtime.resolveManagedTerminalWorkspaceTarget(
          'id:folder:dup',
          'local',
          false
        )
        if (!selected.managedWorktree || !selected.scope.folderWorkspace) {
          throw new Error('missing selected folder')
        }
        await runtime.launchAgentTerminal(
          'id:folder:dup',
          { agent: 'codex', prompt: 'Review' },
          {
            worktree: selected.managedWorktree,
            repo: store.getRepos()[0],
            folderWorkspace: selected.scope.folderWorkspace
          }
        )
        expect(startup).toHaveBeenCalledWith(
          expect.anything(),
          'codex',
          'Review',
          undefined,
          expect.objectContaining({
            launchScope: expect.objectContaining({
              path,
              connectionId: null,
              folderWorkspace: expect.objectContaining({ folderPath: path })
            })
          })
        )
        expect(spawn).toHaveBeenCalledWith(
          expect.objectContaining({
            cwd: path,
            connectionId: null,
            env: expect.objectContaining({ ORCA_WORKSPACE_ROOT: path })
          })
        )
        await expect(
          runtime.showManagedTerminalWorkspace('id:folder:dup', 'local')
        ).resolves.toMatchObject({ path, hostId: 'local' })
        const ssh = await runtime.resolveManagedTerminalWorkspaceTarget(
          'id:folder:dup',
          'ssh:a%2Fb',
          false
        )
        expect(ssh.scope).toMatchObject({ path: '/unserved/remote', connectionId: 'a/b' })
        await expect(
          runtime.showManagedTerminalWorkspace('id:folder:dup', 'ssh:a%2Fb')
        ).rejects.toThrow('folder_workspace_path_unavailable:/unserved/remote')
        folders.splice(folders.indexOf(local), 1)
        await expect(
          runtime.resolveManagedTerminalWorkspaceTarget('id:folder:dup', 'local', false)
        ).rejects.toThrow('selector_not_found')
        await expect(
          runtime.resolveManagedTerminalWorkspaceTarget('id:folder:dup', 'ssh:missing', false)
        ).rejects.toThrow('selector_not_found')
        expect(spawn).toHaveBeenCalledTimes(1)
      } finally {
        await rm(path, { recursive: true, force: true })
      }
    }
  )

  it('passes the selected project WSL override to refresh rather than the global distro', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const local: Repo = {
      id: 'copy',
      path: 'C:\\same',
      kind: 'folder',
      displayName: 'Local',
      badgeColor: '#000',
      addedAt: 1
    }
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [{ ...local, connectionId: 'other' }, local],
      getSettings: () => ({
        ...store.getSettings(),
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'GlobalDistro' }
      }),
      getProjects: () => [
        {
          id: 'project',
          displayName: 'Project',
          badgeColor: '#000',
          sourceRepoIds: ['copy'],
          createdAt: 1,
          updatedAt: 1,
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'ProjectDistro' }
        }
      ]
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: PREFLIGHT_METHODS })
    refresh.mockClear()
    expect(
      await dispatcher.dispatch({
        id: 'wsl',
        authToken: 'test',
        method: 'preflight.refreshAgents',
        params: { worktreeId: 'copy::C:\\same', worktreeHostId: 'local' }
      })
    ).toMatchObject({ ok: true })
    expect(refresh).toHaveBeenCalledWith({
      kind: 'local',
      context: {
        projectRuntime: expect.objectContaining({
          status: 'resolved',
          runtime: expect.objectContaining({ kind: 'wsl', distro: 'ProjectDistro' })
        })
      }
    })
  })
  it.each([false, true])(
    'uses the actual cold and warm folder-project instance in either repo order (reverse=%s)',
    async (reverse) => {
      const local: Repo = {
        id: 'copy',
        path: '/same',
        kind: 'folder',
        displayName: 'Local',
        badgeColor: '#000',
        addedAt: 1
      }
      const ssh: Repo = { ...local, connectionId: 'other' }
      const repos = reverse ? [ssh, local] : [local, ssh]
      const instanceId = '11111111-1111-4111-8111-111111111111'
      const worktreeId = `copy::/same::workspace:${instanceId}`
      const runtime = new OrcaRuntimeService({
        ...store,
        getRepos: () => repos,
        getAllWorktreeMeta: () => ({
          [worktreeId]: makeWorktreeMeta({ hostId: 'local', instanceId })
        })
      })
      const dispatcher = new RpcDispatcher({ runtime, methods: PREFLIGHT_METHODS })
      const call = (method: string, params: unknown) =>
        dispatcher.dispatch({ id: 'qualified', authToken: 'test', method, params })
      detectInstalledAgentsWithShellPathHydrationMock.mockReset().mockResolvedValue(['codex'])
      refresh.mockClear()
      for (const warm of [false, true]) {
        if (warm) {
          await runtime.listManagedWorktrees(undefined, 200)
        }
        expect(
          await call('preflight.detectAgents', { worktreeId, worktreeHostId: 'local' })
        ).toMatchObject({ ok: true, result: ['codex'] })
        expect(
          await call('preflight.refreshAgents', { worktreeId, worktreeHostId: 'local' })
        ).toMatchObject({ ok: true, result: { agents: ['codex'] } })
      }
      expect(refresh).toHaveBeenLastCalledWith({ kind: 'local', context: expect.anything() })
      const probes = detectInstalledAgentsWithShellPathHydrationMock.mock.calls.length
      for (const params of [
        { worktreeId: 'copy::/missing', worktreeHostId: 'local' },
        { worktreeId, worktreeHostId: 'ssh:absent' },
        { worktreeHostId: 'local' },
        { worktreeId, worktreeHostId: 'runtime:unresolved-owner' },
        { worktreeId: FLOATING_TERMINAL_WORKTREE_ID, worktreeHostId: 'local' }
      ]) {
        expect(await call('preflight.detectAgents', params)).toMatchObject({ ok: false })
      }
      expect(detectInstalledAgentsWithShellPathHydrationMock).toHaveBeenCalledTimes(probes)
      const shown = runtime.showManagedWorktree.bind(runtime)
      vi.spyOn(runtime, 'showManagedWorktree').mockImplementation(async (...args) => {
        const row = await shown(...args)
        repos.splice(repos.indexOf(local), 1)
        return row
      })
      expect(
        await call('preflight.refreshAgents', { worktreeId, worktreeHostId: 'local' })
      ).toMatchObject({ ok: false })
      expect(refresh).toHaveBeenCalledTimes(2)
      expect(PREFLIGHT_RUNTIME_CAPABILITIES).toContain('preflight.host-qualified.v1')
    }
  )

  it('proves unique saved-folder ownership and keeps valid local default semantics', async () => {
    const folder = makeFolderWorkspace({ executionHostId: 'local' })
    const ssh = { ...folder, executionHostId: 'ssh:other' as const }
    const folders = [ssh, folder]
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [],
      getFolderWorkspaces: () => folders,
      getProjectGroups: () => [makeFolderProjectGroup()]
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: PREFLIGHT_METHODS })
    detectInstalledAgentsWithShellPathHydrationMock.mockReset().mockResolvedValue(['codex'])
    const params = { worktreeId: `folder:${folder.id}`, worktreeHostId: 'local' }
    const call = () =>
      dispatcher.dispatch({
        id: 'folder',
        authToken: 'test',
        method: 'preflight.detectAgents',
        params
      })
    expect(await call()).toMatchObject({ ok: true, result: ['codex'] })
    expect(detectInstalledAgentsWithShellPathHydrationMock).toHaveBeenLastCalledWith(
      undefined,
      undefined
    )
    folders.splice(1, 1)
    expect(await call()).toMatchObject({ ok: false })
    folders.push(folder, { ...folder })
    expect(await call()).toMatchObject({ ok: false })
    expect(detectInstalledAgentsWithShellPathHydrationMock).toHaveBeenCalledTimes(1)
  })
})
