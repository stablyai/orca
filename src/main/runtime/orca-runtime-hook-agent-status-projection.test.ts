// #11761: headless session.tabs must project live hook status while rejecting identity-only historical rows.
import { describe, expect, it, vi } from 'vitest'
import { makeAgentStatusStoreWiring } from './agent-status-store-wiring.test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import { committingSpawn } from './bind-first-pane.test-fixture'
import { partialRuntimeStore } from './runtime-store-partial-fixture'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
// Pane lookup can remint tab ids by leaf; only an unknown leaf is unresolvable.
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
  rows: AgentStatusIpcPayload[],
  statusWiring?: ReturnType<typeof makeAgentStatusStoreWiring>
): Promise<OrcaRuntimeService> {
  const readRows = statusWiring
    ? (): AgentStatusIpcPayload[] => [...rows, ...statusWiring.deps.getAgentStatusSnapshot()]
    : (): AgentStatusIpcPayload[] => rows
  // Main-owned layout requires a store to resolve PTY pane bindings.
  const store = ORCA_LAYOUT_OWNER_IS_MAIN
    ? partialRuntimeStore({
        getRepos: () => [],
        getRepo: () => undefined,
        getAllWorktreeMeta: () => ({}),
        getWorktreeMeta: () => undefined,
        getProjects: () => [],
        getSettings: () => ({})
      })
    : null
  const runtime = new OrcaRuntimeService(store, undefined, {
    ...(statusWiring
      ? {
          onTerminalAgentStatus: statusWiring.deps.onTerminalAgentStatus,
          reconcileAgentStatusForEndedProcess:
            statusWiring.deps.reconcileAgentStatusForEndedProcess,
          getAgentProviderSessionSnapshot: statusWiring.deps.getAgentProviderSessionSnapshot,
          getAgentProviderSessionRowsForPane: statusWiring.deps.getAgentProviderSessionRowsForPane
        }
      : {}),
    getAgentStatusSnapshot: readRows,
    ...(statusWiring ? {} : { getAgentProviderSessionRowsForPane: readRows })
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
    spawn: vi.fn(committingSpawn(runtime, async () => ({ id: PTY_ID }))),
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

/** Exercise production OSC stamping, including sequence and wall-clock recency. */
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
  it('ranks a completed hook below present launch evidence in terminal identity', async () => {
    const runtime = await createRuntimeWithHookRows([
      hookRow({
        agentType: 'codex',
        state: 'done',
        prompt: '',
        toolName: undefined,
        interactivePrompt: undefined
      })
    ])

    expect((await runtime.listTerminals()).terminals).toEqual([
      expect.objectContaining({ agentIdentity: 'claude' })
    ])
  })

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

  // Resume rows are transport placeholders, including pi-flavored rows; never synthesize live status.
  it.each(['claude', 'pi'])('never fabricates live state from a %s resume row', async (agent) => {
    const agentStatus = await projectAgentStatus([
      hookRow({ agentType: agent, providerSessionOnly: true })
    ])

    expect(agentStatus).toEqual(expect.objectContaining({ state: 'done', prompt: '' }))
    expect(agentStatus).not.toHaveProperty('toolName')
    expect(agentStatus).not.toHaveProperty('interactivePrompt')
  })

  // #12346: hydration receipt time proves no current turn; replaying it revives unanswerable question cards.
  it('refuses a hydrated unconfirmed row as live while keeping its resume identity', async () => {
    const agentStatus = await projectAgentStatus([hookRow({ restoredUnconfirmed: true })])

    expect(agentStatus).toEqual(
      expect.objectContaining({
        state: 'waiting',
        restoredUnconfirmed: true,
        providerSession: PROVIDER_SESSION
      })
    )
    expect(agentStatus).not.toHaveProperty('interactivePrompt')
    expect(agentStatus).not.toHaveProperty('toolName')
  })

  // Daemon-surviving agents may still run after host restart; restored turns are unverifiable, not finished.
  it('keeps a restored working turn unverifiable instead of done', async () => {
    const receivedAt = Date.now() - 60_000
    const agentStatus = await projectAgentStatus([
      hookRow({
        state: 'working',
        prompt: 'refactor the parser',
        toolName: undefined,
        interactivePrompt: undefined,
        receivedAt,
        stateStartedAt: receivedAt - 5_000,
        restoredUnconfirmed: true
      })
    ])

    expect(agentStatus).toEqual(
      expect.objectContaining({
        state: 'working',
        prompt: 'refactor the parser',
        restoredUnconfirmed: true,
        updatedAt: receivedAt,
        stateStartedAt: receivedAt - 5_000
      })
    )
  })

  // Seven-day hydrated retention must not become synthetic done after the 30-minute live window.
  it('keeps a restored turn older than the live freshness window unverifiable', async () => {
    const now = Date.UTC(2026, 9, 17, 12)
    vi.useFakeTimers({ toFake: ['Date'], now })
    try {
      const receivedAt = now - AGENT_STATUS_STALE_AFTER_MS - 60_000
      const agentStatus = await projectAgentStatus([
        hookRow({
          state: 'working',
          prompt: 'refactor the parser',
          toolName: undefined,
          interactivePrompt: undefined,
          receivedAt,
          stateStartedAt: receivedAt,
          restoredUnconfirmed: true
        })
      ])

      expect(agentStatus).toEqual(
        expect.objectContaining({
          state: 'working',
          restoredUnconfirmed: true,
          updatedAt: receivedAt,
          providerSession: PROVIDER_SESSION
        })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a newer confirmed row supersede an old restored turn even once stale', async () => {
    const now = Date.UTC(2026, 9, 17, 12)
    vi.useFakeTimers({ toFake: ['Date'], now })
    try {
      const restoredAt = now - 2 * 60 * 60_000
      const confirmedAt = now - 60 * 60_000
      const agentStatus = await projectAgentStatus([
        hookRow({
          state: 'working',
          toolName: undefined,
          interactivePrompt: undefined,
          receivedAt: restoredAt,
          stateStartedAt: restoredAt,
          restoredUnconfirmed: true
        }),
        hookRow({
          state: 'done',
          toolName: undefined,
          interactivePrompt: undefined,
          receivedAt: confirmedAt,
          stateStartedAt: confirmedAt
        })
      ])

      expect(agentStatus === undefined || agentStatus.state === 'done').toBe(true)
      expect(agentStatus).not.toHaveProperty('restoredUnconfirmed')
    } finally {
      vi.useRealTimers()
    }
  })

  // STA-12043: the retired turn keeps its identity but no state, so no Done sits beside the shell.
  it('lets a shell title retire a restored turn to identity only', async () => {
    const agentStatus = await projectAgentStatus(
      [hookRow({ state: 'working', interactivePrompt: undefined, restoredUnconfirmed: true })],
      (runtime) => observePaneTitle(runtime, 'bash')
    )

    expect(agentStatus).toEqual(
      expect.objectContaining({ state: 'done', prompt: '', restoredUnconfirmed: true })
    )
  })

  it('projects the OSC turn that replaced the hook row in the store', async () => {
    // OSC writes replace the hook row in one store; readers should project its current value.
    const statusWiring = makeAgentStatusStoreWiring()
    statusWiring.statusStore.ingestTerminalStatus({
      paneKey: PANE_KEY,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      connectionId: null,
      payload: { state: 'waiting', prompt: 'Tabs or spaces?', agentType: 'claude' }
    })
    const runtime = await createRuntimeWithHookRows([], statusWiring)
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

  // #1437: inherited toolName cannot reclaim a shell-owned pane; only pending questions survive suppression.
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

  it('keeps the hook transcript address after a manual rename drops the agent glyph', async () => {
    const runtime = await createRuntimeWithHookRows([
      hookRow({
        state: 'done',
        prompt: '',
        toolName: undefined,
        interactivePrompt: undefined
      })
    ])
    observePaneTitle(runtime, '✳ gate question')
    const before = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const beforeTab = before.tabs[0]
    if (beforeTab?.type !== 'terminal' || !beforeTab.terminal) {
      throw new Error('expected a live terminal handle')
    }
    expect(beforeTab.agentStatus).toEqual(
      expect.objectContaining({ providerSession: PROVIDER_SESSION })
    )

    await runtime.renameTerminal(beforeTab.terminal, 'ANSWER HERE: gate 004')

    const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const tab = result.tabs[0]
    expect(tab?.type === 'terminal' && tab.title).toBe('ANSWER HERE: gate 004')
    expect(tab?.type === 'terminal' && tab.agentStatus).toEqual(
      expect.objectContaining({
        agentType: 'claude',
        providerSession: PROVIDER_SESSION
      })
    )
  })

  it('keeps a live working hook after a manual rename', async () => {
    const runtime = await createRuntimeWithHookRows([
      hookRow({
        state: 'working',
        prompt: 'Working on a release',
        toolName: undefined,
        interactivePrompt: undefined
      })
    ])
    observePaneTitle(runtime, '⠋ Claude')
    const { tabs } = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const tab = tabs[0]
    if (tab?.type !== 'terminal' || !tab.terminal) {
      throw new Error('expected a live terminal handle')
    }
    await runtime.renameTerminal(tab.terminal, 'Release review')
    const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const after = result.tabs[0]
    expect(after?.type === 'terminal' ? after.agentStatus : undefined).toMatchObject({
      state: 'working',
      providerSession: PROVIDER_SESSION
    })
  })

  // User labels are not process-title evidence and must not clear live status.
  it('keeps the terminal agent status running after the pane is renamed to a shell name', async () => {
    const runtime = await createRuntimeWithHookRows([
      hookRow({
        state: 'working',
        prompt: 'Working',
        toolName: undefined,
        interactivePrompt: undefined
      })
    ])
    observePaneTitle(runtime, '⠋ Claude')
    const { tabs } = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const handle = tabs[0]?.type === 'terminal' ? tabs[0].terminal : undefined
    if (!handle) {
      throw new Error('expected a live terminal handle')
    }
    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: true
    })

    await runtime.renameTerminal(handle, 'bash')

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: true,
      status: 'working'
    })
  })

  it('retires the renamed agent when its OSC title returns to the shell', async () => {
    const runtime = await createRuntimeWithHookRows([
      hookRow({ state: 'working', prompt: '', toolName: undefined, interactivePrompt: undefined })
    ])
    observePaneTitle(runtime, '✳ gate question')
    const { tabs } = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const tab = tabs[0]
    if (tab?.type !== 'terminal' || !tab.terminal) {
      throw new Error('expected a live terminal handle')
    }
    await runtime.renameTerminal(tab.terminal, 'ANSWER HERE: gate 004')
    observePaneTitle(runtime, 'bash')
    const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const after = result.tabs[0]
    expect(after?.type === 'terminal' ? after.agentStatus : undefined).toMatchObject({
      state: 'done',
      prompt: ''
    })
  })

  it('does not invent a transcript address for a renamed shell pane', async () => {
    const runtime = await createRuntimeWithHookRows([])
    observePaneTitle(runtime, 'zsh')
    const initial = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const initialTab = initial.tabs[0]
    if (initialTab?.type !== 'terminal' || !initialTab.terminal) {
      throw new Error('expected a live terminal handle')
    }

    await runtime.renameTerminal(initialTab.terminal, 'notes')

    const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const tab = result.tabs[0]
    expect(tab?.type === 'terminal' ? tab.agentStatus?.providerSession : undefined).toBeUndefined()
  })

  it('still has no transcript address when a renamed pane never reported a session', async () => {
    const runtime = await createRuntimeWithHookRows([
      hookRow({
        state: 'done',
        prompt: '',
        toolName: undefined,
        interactivePrompt: undefined,
        providerSession: undefined
      })
    ])
    observePaneTitle(runtime, '✳ gate question')
    const initial = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const initialTab = initial.tabs[0]
    if (initialTab?.type !== 'terminal' || !initialTab.terminal) {
      throw new Error('expected a live terminal handle')
    }

    await runtime.renameTerminal(initialTab.terminal, 'ANSWER HERE: gate 004')

    const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const tab = result.tabs[0]
    expect(tab?.type === 'terminal' ? tab.agentStatus?.providerSession : undefined).toBeUndefined()
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

  it('evicts the predecessor row at a certified provider generation reset', async () => {
    const statusWiring = makeAgentStatusStoreWiring()
    const runtime = await createRuntimeWithHookRows([], statusWiring)
    runtime.onPtyData(
      PTY_ID,
      '\x1b]9999;{"state":"working","prompt":"predecessor","agentType":"claude"}\x07',
      1
    )
    expect(statusWiring.statusStore.getStatusSnapshot()).toHaveLength(1)

    const internals = runtime as unknown as {
      resetTrackedTerminalStateForProviderGeneration: (ptyId: string) => void
    }
    internals.resetTrackedTerminalStateForProviderGeneration(PTY_ID)

    expect(statusWiring.statusStore.getStatusSnapshot()).toEqual([])
    statusWiring.statusStore.stop()
  })

  it('evicts a row joined only through the terminal handle on certified PTY exit', async () => {
    const statusWiring = makeAgentStatusStoreWiring()
    const runtime = await createRuntimeWithHookRows([], statusWiring)
    const terminal = (await runtime.listTerminals()).terminals[0]
    if (!terminal) {
      throw new Error('expected a live terminal')
    }
    const priorPaneKey = makePaneKey('prior-tab', UNKNOWN_LEAF_ID)
    statusWiring.statusStore.ingestTerminalStatus({
      paneKey: priorPaneKey,
      tabId: 'prior-tab',
      terminalHandle: terminal.handle,
      payload: { state: 'working', prompt: 'prior pane', agentType: 'claude' }
    })
    expect(statusWiring.statusStore.getStatusSnapshot()).toHaveLength(1)

    observePaneTitle(runtime, '✳ active agent')
    await runtime.renameTerminal(terminal.handle, 'Custom title')

    runtime.onPtyExit(PTY_ID, 0)

    expect(statusWiring.statusStore.getStatusSnapshot()).toEqual([])
    statusWiring.statusStore.stop()
  })

  it('evicts the central status row when a disconnected PTY record is pruned', async () => {
    const statusWiring = makeAgentStatusStoreWiring()
    const runtime = await createRuntimeWithHookRows([], statusWiring)
    runtime.onPtyData(
      PTY_ID,
      '\x1b]9999;{"state":"working","prompt":"before prune","agentType":"claude"}\x07',
      1
    )
    expect(statusWiring.statusStore.getStatusSnapshot()).toHaveLength(1)

    const internals = runtime as unknown as {
      dropDisconnectedPtyRecord: (ptyId: string) => void
    }
    internals.dropDisconnectedPtyRecord(PTY_ID)

    expect(statusWiring.statusStore.getStatusSnapshot()).toEqual([])
    statusWiring.statusStore.stop()
  })

  it('keeps an unverifiable remote row when its disconnected PTY record is pruned', async () => {
    const statusWiring = makeAgentStatusStoreWiring()
    const runtime = await createRuntimeWithHookRows([], statusWiring)
    const internals = runtime as unknown as {
      ptysById: Map<string, { connected: boolean; connectionId: string | null }>
      dropDisconnectedPtyRecord: (ptyId: string) => void
    }
    const pty = internals.ptysById.get(PTY_ID)!
    pty.connectionId = 'ssh-target'
    runtime.onPtyData(
      PTY_ID,
      '\x1b]9999;{"state":"working","prompt":"remote work","agentType":"claude"}\x07',
      1
    )
    pty.connected = false

    internals.dropDisconnectedPtyRecord(PTY_ID)

    expect(statusWiring.statusStore.getStatusSnapshot()).toEqual([
      expect.objectContaining({ connectionId: 'ssh-target', prompt: 'remote work' })
    ])
    statusWiring.statusStore.stop()
  })

  it('evicts a dismissed handle-joined remnant on certified PTY exit', async () => {
    const statusWiring = makeAgentStatusStoreWiring()
    const runtime = await createRuntimeWithHookRows([], statusWiring)
    const terminal = (await runtime.listTerminals()).terminals[0]
    if (!terminal) {
      throw new Error('expected a live terminal')
    }
    const priorPaneKey = makePaneKey('prior-tab', UNKNOWN_LEAF_ID)
    statusWiring.statusStore.ingestTerminalStatus({
      paneKey: priorPaneKey,
      tabId: 'prior-tab',
      terminalHandle: terminal.handle,
      payload: { state: 'working', prompt: 'dismissed pane', agentType: 'claude' }
    })
    statusWiring.statusStore.ingestRemote(
      {
        paneKey: priorPaneKey,
        tabId: 'prior-tab',
        providerSession: PROVIDER_SESSION,
        payload: { state: 'working', prompt: 'dismissed pane', agentType: 'claude' }
      },
      null
    )
    statusWiring.statusStore.dropStatusEntry(priorPaneKey)
    expect(statusWiring.statusStore.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: priorPaneKey, providerSessionOnly: true })
    ])

    runtime.onPtyExit(PTY_ID, 0)

    expect(statusWiring.statusStore.getStatusSnapshot()).toEqual([])
    statusWiring.statusStore.stop()
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

    // Hook updatedAt distinguishes its done from stale-spinner identity fallback.
    expect(tab?.type === 'terminal' && tab.agentStatus).toEqual(
      expect.objectContaining({ state: 'done', updatedAt: reportedAt })
    )
  })
})

// Hook-only changes must bump snapshotVersion or clients discard the frame.
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

  // Version arithmetic proves the unknown pane did not cause a second bump without timing silence.
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

  // Clearing status must remove question cards so they cannot outlive the agent.
  it('retires the question card after the pane status is cleared', async () => {
    const rows = [hookRow()]
    const runtime = await createRuntimeWithHookRows(rows)
    await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const events: { tabs: { type: string; agentStatus?: unknown }[] }[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))

    rows.length = 0
    runtime.touchMobileSessionTabsForPane(PANE_KEY, WORKTREE_ID)

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]!.tabs[0]!.agentStatus).toBeUndefined()
    unsubscribe()
  })
})

it.each(['✳ Claude', '✳ Claude next repaint'])(
  'keeps a working hook when a preexisting idle interval repaints as %s',
  async (repaintTitle) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_700_000_000_000)
    const wiring = makeAgentStatusStoreWiring()
    const runtime = await createRuntimeWithHookRows([], wiring)
    try {
      observePaneTitle(runtime, '✳ Claude')
      vi.setSystemTime(Date.now() + 5_000)
      wiring.statusStore.ingestTerminalStatus({
        paneKey: PANE_KEY,
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        connectionId: null,
        payload: { state: 'working', prompt: 'current hook evidence', agentType: 'claude' }
      })
      const before = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
      expect(before.tabs[0]?.type === 'terminal' && before.tabs[0].agentStatus).toMatchObject({
        state: 'working',
        prompt: 'current hook evidence'
      })
      vi.setSystemTime(Date.now() + 123)
      observePaneTitle(runtime, repaintTitle)
      const after = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
      expect(wiring.statusStore.getStatusSnapshot()[0]).toMatchObject({ state: 'working' })
      expect(after.tabs[0]?.type === 'terminal' && after.tabs[0].agentStatus).toMatchObject({
        state: 'working',
        prompt: 'current hook evidence'
      })
    } finally {
      wiring.statusStore.stop()
      vi.useRealTimers()
    }
  }
)

it('keeps a real idle transition and later done hook authoritative after a working hook', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_700_000_000_000)
  const wiring = makeAgentStatusStoreWiring()
  const runtime = await createRuntimeWithHookRows([], wiring)
  try {
    const ingest = (state: 'working' | 'done'): void => {
      wiring.statusStore.ingestTerminalStatus({
        paneKey: PANE_KEY,
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        connectionId: null,
        payload: {
          state,
          prompt: state === 'working' ? 'current hook evidence' : '',
          agentType: 'claude'
        }
      })
    }
    observePaneTitle(runtime, '✳ Claude')
    vi.setSystemTime(Date.now() + 5_000)
    ingest('working')
    vi.setSystemTime(Date.now() + 123)
    observePaneTitle(runtime, '⠋ Claude')
    vi.setSystemTime(Date.now() + 123)
    observePaneTitle(runtime, '✳ Claude')
    const ended = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    expect(ended.tabs[0]?.type === 'terminal' && ended.tabs[0].agentStatus).toMatchObject({
      state: 'done',
      prompt: ''
    })
    vi.setSystemTime(Date.now() + 123)
    ingest('done')
    const confirmed = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    expect(confirmed.tabs[0]?.type === 'terminal' && confirmed.tabs[0].agentStatus).toMatchObject({
      state: 'done',
      updatedAt: Date.now()
    })
  } finally {
    wiring.statusStore.stop()
    vi.useRealTimers()
  }
})
