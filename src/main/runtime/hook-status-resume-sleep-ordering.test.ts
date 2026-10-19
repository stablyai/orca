// A layout-owner build: a hook status main accepted before a workspace sleep must not replace the
// sleep's record when its queued write lands after the sleep is saved.
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { LayoutApplyOutcome } from '../../shared/workspace-layout/workspace-layout-command-types'
import { applyCommandToSession } from '../persistence/terminal-topology/terminal-pane-admission'
import type { WorktreeSleepResumeCapture } from './terminal/stop/worktree-sleep-resume-records'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

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
const PTY_ID = 'pty-slept'
const SESSION = { key: 'session_id' as const, id: 'codex-session-1' }

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

/** A runtime whose first record write applies at once but holds its durable write open. */
function makeRuntimeWithSlowFirstWrite() {
  const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  let releaseFirstWrite = (): void => {}
  const firstWriteDurable = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve
  })
  let writes = 0
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
      writes += 1
      if (writes === 1) {
        await firstWriteDurable
      }
      return { ok: true, result: {} }
    }
  )
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture store implements the runtime store methods these tests reach.
    Object.assign(runtimeStore, { applyLayoutCommand }) as never
  )
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  return { runtime, getSession, releaseFirstWrite }
}

function sleepCapture(updatedAt: number): WorktreeSleepResumeCapture {
  return new Map([
    [
      PTY_ID,
      {
        retiredPaneKeys: [],
        records: [
          {
            paneKey: PANE_KEY,
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            agent: 'codex',
            providerSession: SESSION,
            prompt: 'keep working',
            state: 'done',
            capturedAt: 20,
            updatedAt,
            origin: 'worktree-sleep',
            restoreOnTabOpenOnly: true,
            connectionId: null
          }
        ]
      }
    ]
  ])
}

describe('a queued hook status and a workspace sleep', () => {
  it('keeps the sleep’s record when a status accepted before the sleep is written after it', async () => {
    const { runtime, getSession, releaseFirstWrite } = makeRuntimeWithSlowFirstWrite()
    // An earlier status's write is still on its way to disk when the next status is accepted.
    runtime.recordHookStatusResume(codexRow())
    await vi.waitFor(() =>
      expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toBeDefined()
    )
    runtime.recordHookStatusResume(codexRow({ state: 'blocked', receivedAt: 11 }))

    // The sleep captured that status from the hook store and saves its record.
    const slept = runtime['sleepResumeRecords'].persist(TEST_WORKTREE_ID, sleepCapture(11), [
      PTY_ID
    ])
    releaseFirstWrite()
    await slept
    await runtime['hookStatusResumeWrites']

    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toMatchObject({
      origin: 'worktree-sleep',
      state: 'done',
      restoreOnTabOpenOnly: true
    })
  })

  it('keeps a window sleep’s record when a status accepted before it is written after it', async () => {
    const { runtime, getSession, releaseFirstWrite } = makeRuntimeWithSlowFirstWrite()
    runtime.recordHookStatusResume(codexRow())
    await vi.waitFor(() =>
      expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toBeDefined()
    )
    runtime.recordHookStatusResume(codexRow({ state: 'blocked', receivedAt: 11 }))

    const [record] = sleepCapture(11).get(PTY_ID)!.records
    const slept = runtime.applyLayoutCommand({
      type: 'sleep',
      workspace: TEST_WORKTREE_ID,
      tabId: 'host-tab',
      paneKeys: [PANE_KEY],
      records: [record!]
    })
    releaseFirstWrite()
    await slept
    await runtime['hookStatusResumeWrites']

    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toMatchObject({
      origin: 'worktree-sleep',
      state: 'done'
    })
  })

  it('lets a status accepted after the sleep is saved replace its record, as the window does', async () => {
    const { runtime, getSession, releaseFirstWrite } = makeRuntimeWithSlowFirstWrite()
    releaseFirstWrite()
    await runtime['sleepResumeRecords'].persist(TEST_WORKTREE_ID, sleepCapture(11), [PTY_ID])

    runtime.recordHookStatusResume(codexRow({ receivedAt: 30 }))
    await runtime['hookStatusResumeWrites']

    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toMatchObject({
      origin: 'live',
      state: 'working'
    })
  })
})
