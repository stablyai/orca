// #11761: on a headless `orca serve` host the HTTP agent hook is the only carrier of
// live agent state, so `session.tabs` must project the hook row's status fields — not
// just its identity — while still refusing rows that only prove an agent once existed.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
// A leaf this runtime never minted: pane lookup recovers a reminted tab id by leaf id,
// so only an unknown leaf id is genuinely unresolvable.
const UNKNOWN_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const TAB_ID = 'ask-tab'
const WORKTREE_ID = 'wt-1'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const PTY_ID = 'pty-ask'
const ASK_PROMPT = JSON.stringify({
  questions: [
    {
      question: 'Tabs or spaces?',
      header: 'Style',
      multiSelect: false,
      options: [{ label: 'Tabs' }, { label: 'Spaces' }]
    }
  ]
})
const PROVIDER_SESSION = {
  key: 'session_id' as const,
  id: 'ac1f6b90-2f77-4f0e-9c5e-1d2f6a4b8c31',
  transcriptPath: '/transcripts/ac1f6b90.jsonl'
}

function hookRow(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  const now = Date.now()
  return {
    paneKey: PANE_KEY,
    state: 'waiting',
    prompt: 'Tabs or spaces?',
    agentType: 'claude',
    toolName: 'AskUserQuestion',
    interactivePrompt: ASK_PROMPT,
    connectionId: null,
    receivedAt: now,
    stateStartedAt: now,
    tabId: TAB_ID,
    worktreeId: WORKTREE_ID,
    providerSession: PROVIDER_SESSION,
    ...overrides
  }
}

async function createRuntimeWithHookRows(
  rows: AgentStatusIpcPayload[]
): Promise<OrcaRuntimeService> {
  const runtime = new OrcaRuntimeService(null, undefined, {
    getAgentStatusSnapshot: () => rows
  })
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WORKTREE_ID,
    path: '/repo/app',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  await runtime.createTerminal(`id:${WORKTREE_ID}`, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    launchAgent: 'claude',
    title: 'Terminal'
  })
  return runtime
}

async function projectAgentStatus(
  rows: AgentStatusIpcPayload[],
  preparePane?: (runtime: OrcaRuntimeService) => void
): Promise<Record<string, unknown> | undefined> {
  const runtime = await createRuntimeWithHookRows(rows)
  preparePane?.(runtime)
  const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
  const tab = result.tabs[0]
  return tab?.type === 'terminal'
    ? (tab.agentStatus as unknown as Record<string, unknown> | undefined)
    : undefined
}

/** Observe a pane title the way production does, so the recency stamps under test are
 *  the ones the OSC path actually writes (a sequence number *and* a wall clock). */
function observePaneTitle(runtime: OrcaRuntimeService, title: string): void {
  runtime.onPtyData(PTY_ID, `\x1b]0;${title}\x07`, Date.now())
}

function lastOscTitleEpochMs(runtime: OrcaRuntimeService): number {
  const pty = (
    runtime as unknown as { ptysById: Map<string, { lastOscTitleEpochMs: number | null }> }
  ).ptysById.get(PTY_ID)
  return pty?.lastOscTitleEpochMs ?? 0
}

describe('headless hook agent-status projection (#11761)', () => {
  it('carries the hook state, tool and interactivePrompt to paired clients', async () => {
    const agentStatus = await projectAgentStatus([hookRow()])

    expect(agentStatus).toEqual(
      expect.objectContaining({
        agentType: 'claude',
        state: 'waiting',
        prompt: 'Tabs or spaces?',
        toolName: 'AskUserQuestion',
        interactivePrompt: ASK_PROMPT,
        providerSession: PROVIDER_SESSION
      })
    )
  })

  it('publishes a gated turn end as event metadata, not stored agent status', async () => {
    const turnCompletedAt = Date.now()
    const runtime = await createRuntimeWithHookRows([
      hookRow({
        state: 'working',
        interactivePrompt: undefined,
        turnCompletedAt
      })
    ])

    const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const tab = result.tabs[0]

    expect(tab).toMatchObject({ type: 'terminal', turnCompletedAt })
    expect(tab?.type === 'terminal' && tab.agentStatus).not.toHaveProperty('turnCompletedAt')
  })

  it('publishes no hook transport identity to clients', async () => {
    const agentStatus = await projectAgentStatus([
      hookRow({ launchToken: 'lt-secret', promptInteractionKey: 'turn-1' })
    ])

    expect(Object.keys(agentStatus ?? {}).sort()).toEqual([
      'agentType',
      'interactivePrompt',
      'paneKey',
      'prompt',
      'providerSession',
      'state',
      'stateHistory',
      'stateStartedAt',
      'tabId',
      'terminalHandle',
      'terminalTitle',
      'toolName',
      'updatedAt',
      'worktreeId'
    ])
  })

  it('falls back to identity-only done once the hook row goes stale', async () => {
    const stale = Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1_000
    const agentStatus = await projectAgentStatus([
      hookRow({ receivedAt: stale, stateStartedAt: stale })
    ])

    expect(agentStatus).toEqual(
      expect.objectContaining({ state: 'done', prompt: '', providerSession: PROVIDER_SESSION })
    )
    expect(agentStatus).not.toHaveProperty('interactivePrompt')
  })

  // Resume-identity rows carry transport placeholders, not status. `agentType`
  // deliberately admits pi's flavour of them — `live` must not, either flavour.
  it.each(['claude', 'pi'])('never fabricates live state from a %s resume row', async (agent) => {
    const agentStatus = await projectAgentStatus([
      hookRow({ agentType: agent, providerSessionOnly: true })
    ])

    expect(agentStatus).toEqual(expect.objectContaining({ state: 'done', prompt: '' }))
    expect(agentStatus).not.toHaveProperty('toolName')
    expect(agentStatus).not.toHaveProperty('interactivePrompt')
  })

  // #12346: a row hydrated from last-status.json may describe a turn that ended while
  // no receiver was up, so its recent `receivedAt` proves nothing. Publishing it would
  // resurrect the question card on every restart, with no agent left to answer it.
  it('refuses a hydrated unconfirmed row while keeping its resume identity', async () => {
    const agentStatus = await projectAgentStatus([hookRow({ restoredUnconfirmed: true })])

    expect(agentStatus).toEqual(
      expect.objectContaining({ state: 'done', prompt: '', providerSession: PROVIDER_SESSION })
    )
    expect(agentStatus).not.toHaveProperty('interactivePrompt')
  })

  // #7970: a retained OSC 9999 row is the pane's own report and keeps precedence.
  it('prefers a retained OSC 9999 row over the hook row', async () => {
    const runtime = await createRuntimeWithHookRows([hookRow()])
    runtime.onPtyData(
      PTY_ID,
      '\x1b]9999;{"state":"working","prompt":"fix the tests","agentType":"claude"}\x07',
      100
    )

    const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const tab = result.tabs[0]

    expect(tab?.type === 'terminal' && tab.agentStatus).toEqual(
      expect.objectContaining({ state: 'working', prompt: 'fix the tests' })
    )
  })

  // #1437: `toolName` is inherited across hook events, so it cannot reopen a pane
  // the shell has reclaimed — only a pending question may survive the suppression.
  it('keeps a shell-reclaimed pane identity-only when the hook row has just a toolName', async () => {
    const agentStatus = await projectAgentStatus(
      [hookRow({ state: 'working', toolName: 'Bash', interactivePrompt: undefined })],
      (runtime) => {
        observePaneTitle(runtime, 'bash')
      }
    )

    expect(agentStatus).toEqual(expect.objectContaining({ state: 'done', prompt: '' }))
    expect(agentStatus).not.toHaveProperty('toolName')
  })

  it('keeps a pending question visible even under a non-agent title', async () => {
    const agentStatus = await projectAgentStatus([hookRow()], (runtime) => {
      observePaneTitle(runtime, 'bash')
    })

    expect(agentStatus).toEqual(
      expect.objectContaining({ state: 'waiting', interactivePrompt: ASK_PROMPT })
    )
  })

  it('does not carry a shell-obscured question into the next working interval', async () => {
    const rows = [hookRow()]
    const runtime = await createRuntimeWithHookRows(rows)
    const questionAt = rows[0]!.receivedAt
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(questionAt + 1)
    try {
      const initial = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
      const initialTab = initial.tabs[0]
      if (initialTab?.type !== 'terminal' || !initialTab.terminal) {
        throw new Error('expected a live terminal handle')
      }
      await runtime.renameTerminal(initialTab.terminal, 'bash')
      observePaneTitle(runtime, 'bash')
      let result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
      let tab = result.tabs[0]
      expect(tab?.type === 'terminal' && tab.agentStatus).toEqual(
        expect.objectContaining({ state: 'waiting', interactivePrompt: ASK_PROMPT })
      )

      dateNow.mockReturnValue(questionAt + 2)
      observePaneTitle(runtime, '⠋ Claude')
      result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
      tab = result.tabs[0]
      expect(tab?.type === 'terminal' && tab.agentStatus).toEqual(
        expect.objectContaining({ state: 'working', prompt: '' })
      )
      expect(tab?.type === 'terminal' && tab.agentStatus).not.toHaveProperty('interactivePrompt')
    } finally {
      dateNow.mockRestore()
    }
  })

  it('does not carry a hook question across a provider generation reset', async () => {
    const runtime = await createRuntimeWithHookRows([hookRow()])
    const internals = runtime as unknown as {
      ptysById: Map<string, { title: string | null }>
      resetTrackedTerminalStateForProviderGeneration: (ptyId: string) => void
    }
    internals.ptysById.get(PTY_ID)!.title = 'bash'
    internals.resetTrackedTerminalStateForProviderGeneration(PTY_ID)

    const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const tab = result.tabs[0]
    expect(tab?.type === 'terminal' && tab.agentStatus).not.toHaveProperty('interactivePrompt')
  })

  it('does not carry a hook question across an identity-only owner title', async () => {
    const runtime = await createRuntimeWithHookRows([hookRow()])
    const internals = runtime as unknown as {
      ptysById: Map<string, { title: string | null }>
    }
    internals.ptysById.get(PTY_ID)!.title = 'bash'
    observePaneTitle(runtime, 'Cursor Agent')

    const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const tab = result.tabs[0]
    expect(tab?.type === 'terminal' && tab.agentStatus).not.toHaveProperty('interactivePrompt')
  })

  // The title path is refreshed live; an older hook `done` must not erase it.
  it('keeps the title-derived working state when the hook row predates the title', async () => {
    const now = Date.now()
    const agentStatus = await projectAgentStatus(
      [
        hookRow({
          state: 'done',
          prompt: '',
          toolName: undefined,
          interactivePrompt: undefined,
          receivedAt: now - 60_000,
          stateStartedAt: now - 60_000
        })
      ],
      (runtime) => {
        observePaneTitle(runtime, '⠋ Claude')
      }
    )

    expect(agentStatus).toEqual(expect.objectContaining({ state: 'working', prompt: '' }))
  })

  // The other direction of the same guard: once the hook reports after the last
  // spinner frame, its state is the newest evidence and must be published.
  it('publishes a hook row received after the latest title observation', async () => {
    const rows = [hookRow()]
    const runtime = await createRuntimeWithHookRows(rows)
    observePaneTitle(runtime, '⠋ Claude')
    const reportedAt = lastOscTitleEpochMs(runtime) + 1_000
    rows[0] = hookRow({
      state: 'done',
      prompt: '',
      toolName: undefined,
      interactivePrompt: undefined,
      receivedAt: reportedAt,
      stateStartedAt: reportedAt
    })

    const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const tab = result.tabs[0]

    // `updatedAt` pins the row's provenance: the identity-only fallback would
    // publish `working` (the stale spinner title) stamped with its own clock.
    expect(tab?.type === 'terminal' && tab.agentStatus).toEqual(
      expect.objectContaining({ state: 'done', updatedAt: reportedAt })
    )
  })
})

// Nothing else republishes `session.tabs` when only a hook row changed, and a
// re-emit at an unchanged `snapshotVersion` is dropped by the client's gate.
describe('hook-driven session tabs republish (#11761)', () => {
  it('bumps the snapshot version and emits through the coalescer', async () => {
    const rows = [hookRow({ state: 'working', toolName: undefined, interactivePrompt: undefined })]
    const runtime = await createRuntimeWithHookRows(rows)
    const before = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const events: { snapshotVersion: number }[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    rows[0] = hookRow()
    runtime.touchMobileSessionTabsForPane(PANE_KEY, WORKTREE_ID)

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]!.snapshotVersion).toBeGreaterThan(before.snapshotVersion)
    unsubscribe()
  })

  // Proven by version arithmetic rather than a timed silence: a pane that wrongly
  // resolved to this workspace would bump the version a second time.
  it('ignores a pane with no resolvable workspace', async () => {
    const runtime = await createRuntimeWithHookRows([hookRow()])
    const before = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const events: { snapshotVersion: number }[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    runtime.touchMobileSessionTabsForPane(makePaneKey('gone-tab', UNKNOWN_LEAF_ID))
    runtime.touchMobileSessionTabsForPane(PANE_KEY, WORKTREE_ID)

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]!.snapshotVersion).toBe(before.snapshotVersion + 1)
    unsubscribe()
  })

  // Without this the live state published above would outlive the agent as a
  // question card no client could ever dismiss.
  it('retires the question card after the pane status is cleared', async () => {
    const rows = [hookRow()]
    const runtime = await createRuntimeWithHookRows(rows)
    await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const events: { tabs: { type: string; agentStatus?: unknown }[] }[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    // What a pane-status clear leaves behind: the pane keeps no hook row at all.
    rows.length = 0
    runtime.touchMobileSessionTabsForPane(PANE_KEY, WORKTREE_ID)

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]!.tabs[0]!.agentStatus).toBeUndefined()
    unsubscribe()
  })
})
