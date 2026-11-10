import { bindPaneFirst } from '../../orca-runtime-tests/bind-first-pane.test-fixture'
// Queued pre-sleep hook writes must not replace the newer saved sleep record.
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { LayoutApplyOutcome } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import { applyCommandToSession } from '../../../persistence/terminal-topology/terminal-pane-admission'
import type { WorktreeSleepResumeCapture } from './worktree-sleep-resume-records'

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
  return {
    runtime,
    getSession,
    setSession,
    releaseFirstWrite,
    firstWriteEntered: firstWriteEntered.promise
  }
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

describe('the explicit sleep owner before and after a stop', () => {
  function makePreparedSleep() {
    const fixture = makeRuntimeWithSlowFirstWrite()
    fixture.releaseFirstWrite()
    bindPaneFirst(fixture.runtime, {
      worktreeId: TEST_WORKTREE_ID,
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      ptyId: PTY_ID,
      incarnationId: 'sleep-incarnation'
    })
    fixture.runtime.registerPty(PTY_ID, TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      incarnationId: 'sleep-incarnation'
    })
    const capture: WorktreeSleepResumeCapture = new Map([
      [
        PTY_ID,
        {
          retiredPaneKeys: [],
          records: [
            {
              kind: 'display-only',
              paneKey: PANE_KEY,
              tabId: 'host-tab',
              worktreeId: TEST_WORKTREE_ID,
              origin: 'worktree-sleep',
              capturedAt: 20,
              display: {
                state: 'done',
                agentType: 'custom-cli',
                prompt: 'task',
                updatedAt: 10,
                stateStartedAt: 10,
                interrupted: true
              }
            }
          ]
        }
      ]
    ])
    return { ...fixture, capture }
  }

  it.each([true, false])(
    'stages before stop and rolls back only a proven running target (%s)',
    async (running) => {
      const { runtime, getSession, capture } = makePreparedSleep()
      const { settle } = await runtime['sleepResumeRecords'].prepare(
        TEST_WORKTREE_ID,
        capture,
        () => true
      )
      expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toMatchObject({
        kind: 'display-only',
        display: { state: 'done', agentType: 'custom-cli', interrupted: true }
      })
      await settle(running ? [PTY_ID] : [])
      if (running) {
        expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toBeUndefined()
      } else {
        expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]?.kind).toBe('display-only')
      }
    }
  )

  it('does not restore a staged predecessor over a genuine successor or a closed leaf', async () => {
    const { runtime, getSession, capture, setSession } = makePreparedSleep()
    const { settle } = await runtime['sleepResumeRecords'].prepare(
      TEST_WORKTREE_ID,
      capture,
      () => true
    )
    runtime.recordHookStatusResume(codexRow({ receivedAt: 30, stateStartedAt: 30 }))
    await runtime['hookStatusResumeWrites']
    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toMatchObject({
      origin: 'live'
    })
    await settle([PTY_ID])
    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toMatchObject({
      origin: 'live'
    })
    setSession({ ...getSession(), sleepingAgentSessionsByPaneKey: {} })
    await settle([PTY_ID])
    expect(getSession().sleepingAgentSessionsByPaneKey).toEqual({})
  })

  it('keeps a display-only pane on shell open, retires it for accepted terminal activity, and never resurrects it', async () => {
    const { runtime, getSession, capture } = makePreparedSleep()
    await runtime['sleepResumeRecords'].prepare(TEST_WORKTREE_ID, capture, () => true)
    const tab = {
      type: 'terminal' as const,
      id: PANE_KEY,
      parentTabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      title: 'Codex',
      launchAgent: 'codex' as const,
      isActive: false
    }
    expect(await runtime['resolvePaneOwnedResumeStartup'](TEST_WORKTREE_ID, tab)).toEqual({})
    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]?.kind).toBe('display-only')
    runtime.onPtyData(PTY_ID, '\x1b]0;✳ Claude Code\x07', 2_000_001)
    await runtime['hookStatusResumeWrites']
    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toBeUndefined()
    runtime.onPtyExit(PTY_ID, 0, TEST_WORKTREE_ID)
    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toBeUndefined()
  })
})

it.each(['custom-cli', 'claude', 'codex'] as const)(
  'captures old accepted %s status through the host before stop with exact clocks and verdict',
  async (agent) => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000)
    try {
      const { runtime, getSession } = makeRuntimeWithSlowFirstWrite()
      bindPaneFirst(runtime, {
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        ptyId: PTY_ID
      })
      runtime.registerPty(PTY_ID, TEST_WORKTREE_ID, null, {
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID
      })
      Object.assign(runtime, {
        getAgentProviderSessionSnapshotFn: () => [
          {
            paneKey: PANE_KEY,
            worktreeId: TEST_WORKTREE_ID,
            tabId: 'host-tab',
            agentType: agent,
            ...(agent !== 'custom-cli'
              ? { providerSession: { key: 'session_id', id: 'old-session' } }
              : {}),
            state: 'done',
            prompt: 'finish the task',
            receivedAt: 900,
            stateStartedAt: 800,
            connectionId: null,
            interrupted: true,
            lastAssistantMessage: 'Stopped by user',
            lastAssistantMessageIsToolOutput: true
          }
        ]
      })
      const capture = await runtime['sleepResumeRecords'].capture(
        TEST_WORKTREE_ID,
        new Set([PTY_ID])
      )
      await runtime['sleepResumeRecords'].prepare(TEST_WORKTREE_ID, capture, () => true)
      const record = getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]
      const display = record?.kind === 'display-only' ? record.display : record
      expect(record?.capturedAt).toBe(2_000_000)
      expect(display).toMatchObject({
        state: 'done',
        prompt: 'finish the task',
        updatedAt: 900,
        stateStartedAt: 800,
        interrupted: true,
        lastAssistantMessage: 'Stopped by user',
        lastAssistantMessageIsToolOutput: true
      })
      if (agent !== 'custom-cli') {
        expect(record).toMatchObject({
          agent,
          providerSession: { key: 'session_id', id: 'old-session' }
        })
      } else {
        expect(record?.kind).toBe('display-only')
      }
    } finally {
      vi.useRealTimers()
    }
  }
)

it('does not capture the previous conversation after main starts a new shell in its pane', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(2_000_000)
  try {
    const { runtime } = makeRuntimeWithSlowFirstWrite()
    bindPaneFirst(runtime, {
      worktreeId: TEST_WORKTREE_ID,
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      ptyId: PTY_ID
    })
    runtime.registerPty(PTY_ID, TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    runtime.noteTerminalSpawnCommit({ id: PTY_ID })
    runtime.onPtyData(PTY_ID, '\x1b]0;zsh\x07', 2_000_000)
    Object.assign(runtime, {
      getAgentProviderSessionSnapshotFn: () => [
        codexRow({ state: 'done', receivedAt: 1_880_000, stateStartedAt: 1_880_000 })
      ]
    })
    const capture = await runtime['sleepResumeRecords'].capture(TEST_WORKTREE_ID, new Set([PTY_ID]))
    expect([...capture.values()].flatMap((value) => value.records)).toEqual([])
  } finally {
    vi.useRealTimers()
  }
})

it.each(['restored', 'replay'] as const)(
  'preserves the attached process’s %s source on manual sleep without minting completion',
  async (source) => {
    const { runtime, getSession, releaseFirstWrite } = makeRuntimeWithSlowFirstWrite()
    releaseFirstWrite()
    bindPaneFirst(runtime, {
      worktreeId: TEST_WORKTREE_ID,
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      ptyId: PTY_ID
    })
    runtime.registerPty(PTY_ID, TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    Object.assign(runtime, {
      getAgentProviderSessionSnapshotFn: () => [
        codexRow({
          state: 'done',
          prompt: 'original task',
          lastAssistantMessage: 'original reply',
          receivedAt: 900,
          stateStartedAt: 800,
          ...(source === 'restored' ? { restoredUnconfirmed: true } : { isReplay: true })
        })
      ]
    })
    const capture = await runtime['sleepResumeRecords'].capture(TEST_WORKTREE_ID, new Set([PTY_ID]))
    await runtime['sleepResumeRecords'].prepare(TEST_WORKTREE_ID, capture, () => true)
    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toMatchObject({
      agent: 'codex',
      providerSession: SESSION,
      prompt: 'original task',
      lastAssistantMessage: 'original reply',
      updatedAt: 900,
      stateStartedAt: 800,
      completion: { kind: 'passive' }
    })
  }
)
