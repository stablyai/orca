// A pane's saved recipe follows main's word on its launch, not the session the agent names.
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { LayoutApplyOutcome } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import { applyCommandToSession } from '../../../persistence/terminal-topology/terminal-pane-admission'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

// Preserve side-effect order: mocks, lifecycle, fixtures.
await import('../../orca-runtime-tests/runtime-test-module-registration.spec')
const { OrcaRuntimeService } = await import('../../orca-runtime')
await import('../../orca-runtime-tests/orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('../../orca-runtime-tests/orca-runtime-test-fixtures.spec')

const PANE_KEY = `host-tab:${HEADLESS_LEAF_ID}`
const PTY_ID = 'persisted-pty'
const SESSION = { key: 'session_id' as const, id: 'claude-session-1' }
const RECIPE = { agentArgs: '--dangerously-skip-permissions', agentEnv: {} }

function savedRecord(origin: SleepingAgentSessionRecord['origin']): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    tabId: 'host-tab',
    worktreeId: TEST_WORKTREE_ID,
    agent: 'claude',
    providerSession: SESSION,
    prompt: '',
    state: 'done',
    capturedAt: 5,
    updatedAt: 5,
    origin,
    connectionId: null,
    launchConfig: RECIPE
  }
}

function claudeRow(): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    worktreeId: TEST_WORKTREE_ID,
    agentType: 'claude',
    providerSession: SESSION,
    state: 'working',
    prompt: 'keep going',
    receivedAt: 10,
    stateStartedAt: 10,
    connectionId: null
  }
}

function makeRuntime(saved: SleepingAgentSessionRecord) {
  const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      sleepingAgentSessionsByPaneKey: { [PANE_KEY]: saved }
    })
  )
  const applyLayoutCommand = vi.fn(
    async (
      command: Parameters<typeof applyCommandToSession>[2],
      hostIds: ExecutionHostId[]
    ): Promise<LayoutApplyOutcome> => {
      for (const hostId of hostIds) {
        const change = applyCommandToSession(hostId, getSession(), command)
        if (change.session) {
          setSession(change.session)
        }
      }
      return { ok: true, result: {} }
    }
  )
  const runtime = new OrcaRuntimeService(Object.assign(runtimeStore, { applyLayoutCommand }))
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  const binding = { tabId: 'host-tab', leafId: HEADLESS_LEAF_ID, incarnationId: 'p1' }
  return {
    runtime,
    binding,
    getSession,
    savedAfterStatus: async () => {
      runtime.recordHookStatusResume(claudeRow())
      await runtime['hookStatusResumeWrites']
      return getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]
    }
  }
}

describe('a pane saved recipe and the launch running in it', () => {
  it('gives an agent typed into a fresh shell none of the session earlier recipe', async () => {
    const { runtime, binding, savedAfterStatus } = makeRuntime(savedRecord('live'))
    runtime.registerPty(PTY_ID, TEST_WORKTREE_ID, null, { ...binding, freshSpawn: true })
    const saved = await savedAfterStatus()
    expect(saved?.state).toBe('working')
    expect(saved?.launchConfig).toBeUndefined()
  })

  it('keeps a sleep snapshot for its wake without lending its recipe to a typed resume', async () => {
    const { runtime, binding, getSession, savedAfterStatus } = makeRuntime(
      savedRecord('worktree-sleep')
    )
    runtime.registerPty(PTY_ID, TEST_WORKTREE_ID, null, {
      ...binding,
      agentLaunchAuthority: { launchToken: 'launch-1', launchAgent: 'claude', launchConfig: RECIPE }
    })
    runtime.emitDaemonPtyTransientFact(PTY_ID, { kind: 'command-finished', exitCode: 0 })
    expect(await savedAfterStatus()).toEqual(savedRecord('worktree-sleep'))
    Object.assign(runtime, { getAgentProviderSessionSnapshotFn: () => [claudeRow()] })
    expect(runtime.quitResumeRecordsFor(getSession())).toEqual([])
  })
})
