import { describe, expect, it, vi } from 'vitest'
import {
  committingSpawn,
  registerLivePty
} from '../../terminal/layout/bind-first-pane.test-fixture'
import '../../construction/test-context/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import '../../orca-runtime-test-mocks/setup.spec'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import {
  HEADLESS_LEAF_ID,
  RESTORED_AUTHORITY_TOKEN,
  RESTORED_AUTHORITY_TOKEN_HASH,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'
import { spawnedPtyEnv } from '../../terminal/launch/spawned-pty-env-fixtures'
import '../../../../shared/agent-launch/startup/jcode-runtime-dir'

describe('OrcaRuntimeService', () => {
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
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

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

    expect(retireAuthority).toHaveBeenCalledWith(spawnEnv.ORCA_PANE_KEY, { confirmedExit: true })
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
    await runtime.syncWindowGraph(TEST_WINDOW_ID, {
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
})
