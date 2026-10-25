// A layout-owner build: main keeps the resume record of a pane it holds from the hook status it
// accepts, so an agent in a tab no window holds still resumes after a quit.
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { LayoutApplyOutcome } from '../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { applyCommandToSession } from '../persistence/terminal-topology/terminal-pane-admission'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-test-fixtures.spec')

const PANE_KEY = `host-tab:${HEADLESS_LEAF_ID}`
const SESSION = { key: 'session_id' as const, id: 'codex-session-1' }

function makeRuntime() {
  const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
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
  // No window holds any tab.
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  return { runtime, getSession, applyLayoutCommand }
}

function codexRow(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    worktreeId: TEST_WORKTREE_ID,
    agentType: 'codex',
    providerSession: SESSION,
    state: 'working',
    prompt: 'keep working',
    receivedAt: 10,
    stateStartedAt: 10,
    connectionId: null,
    ...overrides
  }
}

async function settled(runtime: InstanceType<typeof OrcaRuntimeService>): Promise<void> {
  await runtime['hookStatusResumeWrites']
}

function recordOf(session: WorkspaceSessionState) {
  return session.sleepingAgentSessionsByPaneKey?.[PANE_KEY]
}

describe('main records a held pane’s resume record from its hook status', () => {
  it('records a working agent in a tab no window holds', async () => {
    const { runtime, getSession } = makeRuntime()

    runtime.recordHookStatusResume(codexRow())
    await settled(runtime)

    expect(recordOf(getSession())).toMatchObject({
      paneKey: PANE_KEY,
      tabId: 'host-tab',
      worktreeId: TEST_WORKTREE_ID,
      agent: 'codex',
      providerSession: SESSION,
      state: 'working',
      prompt: 'keep working',
      origin: 'live'
    })
  })

  it('writes once for statuses that do not change how the agent resumes', async () => {
    const { runtime, applyLayoutCommand } = makeRuntime()

    runtime.recordHookStatusResume(codexRow())
    runtime.recordHookStatusResume(codexRow({ prompt: 'next prompt', receivedAt: 11 }))
    await settled(runtime)

    expect(applyLayoutCommand).toHaveBeenCalledOnce()
  })

  it('keeps the provider session a later status of the same turn does not repeat', async () => {
    const { runtime, getSession } = makeRuntime()

    runtime.recordHookStatusResume(codexRow())
    runtime.recordHookStatusResume(codexRow({ providerSession: undefined, state: 'blocked' }))
    await settled(runtime)

    expect(recordOf(getSession())).toMatchObject({ state: 'blocked', providerSession: SESSION })
  })

  it('drops the record when the pane now runs an agent it cannot resume', async () => {
    const { runtime, getSession } = makeRuntime()
    runtime.recordHookStatusResume(codexRow())
    await settled(runtime)

    runtime.recordHookStatusResume(codexRow({ agentType: 'amp', providerSession: undefined }))
    await settled(runtime)

    expect(recordOf(getSession())).toBeUndefined()
  })

  it('leaves the record when the status is cleared, as lost contact is no evidence', async () => {
    const { runtime, getSession } = makeRuntime()
    runtime.recordHookStatusResume(codexRow({ connectionId: 'ssh-1' }))
    await settled(runtime)

    runtime.forgetHookStatusResume({ transient: true, connectionId: 'ssh-1', clearedAt: 20 })

    expect(recordOf(getSession())).toMatchObject({ connectionId: 'ssh-1' })
  })

  it('records nothing for a pane main does not hold', async () => {
    const { runtime, getSession, applyLayoutCommand } = makeRuntime()

    runtime.recordHookStatusResume(codexRow({ paneKey: `other-tab:${HEADLESS_LEAF_ID}` }))
    await settled(runtime)

    expect(applyLayoutCommand).not.toHaveBeenCalled()
    expect(getSession().sleepingAgentSessionsByPaneKey ?? {}).toEqual({})
  })

  it('captures the held pane’s running agent at quit', async () => {
    const rows = [codexRow()]
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const runtime = new OrcaRuntimeService(runtimeStore, undefined, {
      getAgentProviderSessionSnapshot: () => rows
    })

    const [record] = runtime.quitResumeRecordsFor(makeWorkspaceSessionWithHeadlessTerminal())

    expect(record).toMatchObject({ paneKey: PANE_KEY, state: 'working', origin: 'quit' })
  })
})
