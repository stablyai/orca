import {
  makeRuntimeOrchestrationDb,
  dispatchContextRow
} from './runtime-orchestration-db.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import 'node:path'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import 'node:fs/promises'
import '../orca-runtime-test-mocks/setup.spec'
import '../terminal/view/terminal-view-attribute-store'
import 'node:os'
import {
  HEADLESS_LEAF_ID,
  RESTORED_AUTHORITY_TOKEN,
  RESTORED_AUTHORITY_TOKEN_HASH,
  TEST_REPO_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from './orca-runtime-test-fixtures.spec'
import '../terminal/launch/spawned-pty-env-fixtures'

describe('OrcaRuntimeService', () => {
  it('preserves SSH dispatch authority commitment across transient relay loss', async () => {
    const targetId = 'ssh-1'
    const ptyId = `ssh:${targetId}@@pty-retained`
    const tabId = 'ssh-worker'
    const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
    const incarnationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const sshSession = makeWorkspaceSessionWithHeadlessTerminal({
      activeTabId: tabId,
      activeTabIdByWorktree: { [TEST_WORKTREE_ID]: tabId },
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: tabId,
            ptyId,
            worktreeId: TEST_WORKTREE_ID,
            title: 'SSH worker',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        [tabId]: makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: ptyId })
      },
      terminalPtyIncarnationsByPaneKey: { [paneKey]: incarnationId }
    })
    const retireAuthority = vi.fn()
    const failDispatch = vi.fn()
    const runtime = new OrcaRuntimeService(
      {
        ...store,
        // The worker's repo lives on the SSH target whose partition holds its session.
        getRepos: () => [{ ...store.getRepo(TEST_REPO_ID)!, connectionId: targetId }],
        getRepo: (id: string) =>
          id === TEST_REPO_ID
            ? { ...store.getRepo(TEST_REPO_ID)!, connectionId: targetId }
            : undefined,
        getWorkspaceSession: (hostId?: string | null) =>
          hostId === `ssh:${targetId}` ? sshSession : getDefaultWorkspaceSession(),
        getWorkspaceSessionHostIds: () => ['local', `ssh:${targetId}`]
      },
      undefined,
      {
        attestAgentHookCompatibilityAuthority: ({
          paneKey: candidate,
          launchTokenHash,
          connectionId
        }) =>
          candidate === paneKey &&
          launchTokenHash === RESTORED_AUTHORITY_TOKEN_HASH &&
          connectionId === targetId
            ? { paneKey: candidate, source: 'hydrated_commitment' }
            : null,
        retireAgentHookCompatibilityAuthority: retireAuthority
      }
    )
    const orchestrationDb = makeRuntimeOrchestrationDb()
    vi.spyOn(orchestrationDb, 'getActiveDispatchForTerminal').mockImplementation(
      (handle: string) =>
        handle === 'term_ssh_retained'
          ? dispatchContextRow({ id: 'dispatch-ssh', task_id: 'task-ssh', status: 'dispatched' })
          : undefined
    )
    vi.spyOn(orchestrationDb, 'failDispatch').mockImplementation(failDispatch)
    runtime.setOrchestrationDb(orchestrationDb)
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.syncWindowGraph(TEST_WINDOW_ID, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'SSH worker',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId
        }
      ]
    })
    const listProcesses = vi.fn(async () => [
      {
        id: ptyId,
        incarnationId,
        terminalHandle: 'term_ssh_retained',
        title: 'SSH worker',
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
    const refreshInventory = (connectionId: string | undefined) =>
      (
        runtime as unknown as {
          refreshPtyWorktreeRecordsWithControllerInventory: (
            worktrees: [],
            targetWorktreeId: string | null,
            deadline: number | undefined,
            connectionId: string | undefined
          ) => Promise<unknown>
        }
      ).refreshPtyWorktreeRecordsWithControllerInventory([], null, undefined, connectionId)
    const host = runtime.registerOrchestrationCompatibilitySshAttachment(
      targetId,
      'connection-incarnation'
    )
    const evidence = {
      terminalHandle: 'term_ssh_retained',
      paneKey,
      launchToken: RESTORED_AUTHORITY_TOKEN,
      host
    } as const

    await expect(refreshInventory(targetId)).resolves.not.toBeNull()
    expect(runtime.verifyOrchestrationCompatibilityCaller(evidence)).not.toBeNull()
    await expect(refreshInventory(undefined)).resolves.not.toBeNull()
    expect(runtime.verifyOrchestrationCompatibilityCaller(evidence)).not.toBeNull()

    runtime.onPtyExit(ptyId, -1, incarnationId)

    expect(runtime.verifyOrchestrationCompatibilityCaller(evidence)).toBeNull()
    expect(retireAuthority).not.toHaveBeenCalled()
    expect(failDispatch).not.toHaveBeenCalled()

    await expect(refreshInventory(targetId)).resolves.not.toBeNull()

    expect(runtime.verifyOrchestrationCompatibilityCaller(evidence)).not.toBeNull()
    expect(listProcesses).toHaveBeenCalledTimes(3)
  })

  it('does not register or publish a PTY incarnation that exited before spawn resolved', async () => {
    const runtime = new OrcaRuntimeService(store)
    const tabId = '11111111-1111-4111-8111-111111111111'
    const leafId = '22222222-2222-4222-8222-222222222222'
    runtime.setPtyController({
      spawn: vi.fn(async () => {
        runtime.beginPtyRegistration('pty-exited-during-start', 'incarnation-exited-during-start')
        runtime.onPtyExit('pty-exited-during-start', 0, 'incarnation-exited-during-start')
        return {
          id: 'pty-exited-during-start',
          incarnationId: 'incarnation-exited-during-start'
        }
      }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        command: 'codex',
        presentation: 'background',
        tabId,
        leafId
      })
    ).rejects.toThrow('agent_session_exited_during_start')
    await expect(runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)).resolves.toMatchObject({
      terminals: []
    })
    await expect(runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).resolves.toMatchObject({
      tabs: []
    })
    const internals = runtime as unknown as {
      handleByPtyId: Map<string, string>
      ptysById: Map<string, unknown>
    }
    expect(internals.handleByPtyId.has('pty-exited-during-start')).toBe(false)
    expect(internals.ptysById.has('pty-exited-during-start')).toBe(false)
  })
})
