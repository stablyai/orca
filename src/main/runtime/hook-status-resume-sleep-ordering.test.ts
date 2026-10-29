// Queued pre-sleep hook writes must not replace the newer saved sleep record.
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { LayoutApplyOutcome } from '../../shared/workspace-layout/workspace-layout-command-types'
import { applyCommandToSession } from '../persistence/terminal-topology/terminal-pane-admission'
import type { WorktreeSleepResumeCapture } from './terminal/stop/worktree-sleep-resume-records'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

// Preserve side-effect order: mocks, lifecycle, fixtures.
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

function makeRuntimeWithSlowFirstWrite() {
  const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  let releaseFirstWrite = (): void => {}
  const firstWriteDurable = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve
  })
  const firstWriteEntered = Promise.withResolvers<void>()
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
        firstWriteEntered.resolve()
        await firstWriteDurable
      }
      return { ok: true, result: {} }
    }
  )
  const runtime = new OrcaRuntimeService(Object.assign(runtimeStore, { applyLayoutCommand }))
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  return { runtime, getSession, releaseFirstWrite, firstWriteEntered: firstWriteEntered.promise }
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
    const { runtime, getSession, releaseFirstWrite, firstWriteEntered } =
      makeRuntimeWithSlowFirstWrite()
    runtime.recordHookStatusResume(codexRow())
    await firstWriteEntered
    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toBeDefined()
    runtime.recordHookStatusResume(codexRow({ state: 'blocked', receivedAt: 11 }))

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
    const { runtime, getSession, releaseFirstWrite, firstWriteEntered } =
      makeRuntimeWithSlowFirstWrite()
    runtime.recordHookStatusResume(codexRow())
    await firstWriteEntered
    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toBeDefined()
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

it.each([false, true])(
  'orders refused cleanup after queued status and preserves newer same-conversation recipe (%s)',
  async (newer) => {
    const { runtime, getSession, releaseFirstWrite } = makeRuntimeWithSlowFirstWrite()
    runtime.recordHookStatusResume(codexRow())
    await vi.waitFor(() =>
      expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toBeDefined()
    )
    runtime.recordHookStatusResume(codexRow({ state: 'blocked', receivedAt: 11 }))
    const sourcePromise = runtime.readSavedResumeSource(TEST_WORKTREE_ID, PANE_KEY)
    releaseFirstWrite()
    const source = await sourcePromise
    if (!source) {
      throw new Error('missing captured source')
    }
    const refused = {
      agent: 'codex' as const,
      providerSession: SESSION,
      expectedStatus: { paneKey: PANE_KEY, receivedAt: 11, stateStartedAt: 10 },
      expectedSavedRecord: {
        paneKey: PANE_KEY,
        capturedAt: source.capturedAt,
        updatedAt: source.updatedAt
      }
    }
    if (newer) {
      runtime.recordHookStatusResume(codexRow({ receivedAt: 30, prompt: 'new explicit C' }))
    }
    await runtime.forgetRefusedSavedResume(TEST_WORKTREE_ID, PANE_KEY, refused, source)
    await runtime['hookStatusResumeWrites']
    const record = getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]
    if (newer) {
      expect(record).toMatchObject({ prompt: 'new explicit C', updatedAt: 30 })
    } else {
      expect(getSession().sleepingAgentSessionsByPaneKey).toEqual({})
    }
  }
)

it.each([10, 100])(
  'counts actual refused cleanup copies/writes over %i saved panes',
  async (size) => {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const source = sleepCapture(11).get(PTY_ID)!.records[0]!
    session.sleepingAgentSessionsByPaneKey = Object.fromEntries(
      Array.from({ length: size }, (_, index) => [
        `pane-${index}`,
        { ...source, paneKey: `pane-${index}` }
      ])
    )
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore)
    const originalClone = globalThis.structuredClone
    let copied = 0
    let clones = 0
    const clone = vi.spyOn(globalThis, 'structuredClone').mockImplementation((value, options) => {
      if (value && typeof value === 'object' && 'sleepingAgentSessionsByPaneKey' in value) {
        copied += Object.keys(value.sleepingAgentSessionsByPaneKey ?? {}).length
        clones += 1
      }
      return originalClone(value, options)
    })
    const clear = (index: number, stale = false) => {
      const paneKey = `pane-${index}`
      const record = { ...source, paneKey }
      return runtime.forgetRefusedSavedResume(
        TEST_WORKTREE_ID,
        paneKey,
        {
          agent: 'codex',
          providerSession: SESSION,
          expectedSavedRecord: {
            paneKey,
            capturedAt: stale ? -1 : record.capturedAt,
            updatedAt: record.updatedAt
          }
        },
        record
      )
    }
    try {
      await clear(0, true)
      expect([clones, copied, runtimeStore.flushOrThrow.mock.calls.length]).toEqual([1, size, 0])
      // The durable fixture executes the real mutation/rollback, failing only its disk-write primitive.
      runtimeStore.flushOrThrow.mockImplementationOnce(() => {
        throw new Error('disk full')
      })
      await expect(clear(0)).rejects.toThrow('disk full')
      expect(getSession().sleepingAgentSessionsByPaneKey?.['pane-0']).toBeDefined()
      clones = 0
      copied = 0
      runtimeStore.flushOrThrow.mockClear()
      await Promise.all(Array.from({ length: size }, (_, index) => clear(index)))
      // Each accepted edit clones before deleting, then stages one smaller map: sum(2k-1)=N².
      expect([clones, copied, runtimeStore.flushOrThrow.mock.calls.length]).toEqual([
        2 * size,
        size * size,
        size
      ])
      expect(getSession().sleepingAgentSessionsByPaneKey).toEqual({})
      await clear(0)
      expect([clones, copied, runtimeStore.flushOrThrow.mock.calls.length]).toEqual([
        2 * size + 1,
        size * size,
        size
      ])
    } finally {
      clone.mockRestore()
    }
  }
)
