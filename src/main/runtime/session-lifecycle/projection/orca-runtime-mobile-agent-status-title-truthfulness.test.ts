// Neutral titles prove no completion; stamp identity fallback with evidence time so output cannot outrank live client status.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { projectSessionTabAgentStatus } from '../../rpc/methods/session-tabs/session-tab-agent-status-projection'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TAB_ID = 'remote-tab'
const WORKTREE_ID = 'wt-1'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const PTY_ID = 'pty-remote'
const T0 = 1_700_000_000_000
const PROVIDER_SESSION = {
  key: 'session_id' as const,
  id: 'ac1f6b90-2f77-4f0e-9c5e-1d2f6a4b8c31',
  transcriptPath: '/transcripts/ac1f6b90.jsonl'
}

async function createRuntime(
  rows: AgentStatusIpcPayload[] = [],
  launchAgent: 'claude' | 'pi' = 'claude'
): Promise<OrcaRuntimeService> {
  const runtime = new OrcaRuntimeService(null, undefined, {
    getAgentStatusSnapshot: () => rows,
    getPublicAgentStatusSnapshotForPane: (paneKey) => rows.filter((row) => row.paneKey === paneKey)
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
    launchAgent,
    title: 'Terminal'
  })
  return runtime
}

/** Publish the renderer's terminal/title/byte-derived status as a paired host mirrors it. */
async function publishRendererWorkingPane(
  runtime: OrcaRuntimeService,
  paneTitle: string,
  status?: AgentStatusEntry,
  launchAgent: 'claude' | 'pi' = 'claude'
): Promise<void> {
  runtime.attachWindow(1)
  await runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: PTY_ID,
        paneTitle
      }
    ],
    mobileSessionTabs: [
      {
        worktree: WORKTREE_ID,
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: `${TAB_ID}::${LEAF_ID}`,
        activeTabType: 'terminal',
        tabs: [
          {
            type: 'terminal',
            id: `${TAB_ID}::${LEAF_ID}`,
            parentTabId: TAB_ID,
            leafId: LEAF_ID,
            title: paneTitle,
            launchAgent,
            agentStatus: status ?? {
              state: 'working',
              prompt: 'Configurar y entender los comprobantes',
              updatedAt: T0,
              stateStartedAt: T0,
              agentType: 'claude',
              paneKey: PANE_KEY,
              stateHistory: []
            },
            isActive: true
          }
        ]
      }
    ]
  })
}

async function projectTerminalTab(runtime: OrcaRuntimeService) {
  return (await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs[0]
}

async function projectAgentStatus(
  runtime: OrcaRuntimeService
): Promise<Record<string, unknown> | undefined> {
  const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
  const tab = result.tabs[0]
  return tab?.type === 'terminal'
    ? (tab.agentStatus as unknown as Record<string, unknown> | undefined)
    : undefined
}

describe('mobile session tabs: live-title evidence vs published agent status', () => {
  it('keeps a hook-backed working status that postdates an initial Windows ConPTY shell title', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(T0 - 1_000)
      const runtime = await createRuntime()
      runtime.onPtyData(PTY_ID, '\x1b]0;C:\\WINDOWS\\system32\\cmd.exe\x07', T0 - 1_000)

      vi.setSystemTime(T0)
      await publishRendererWorkingPane(runtime, 'C:\\WINDOWS\\system32\\cmd.exe')

      expect(await projectAgentStatus(runtime)).toEqual(
        expect.objectContaining({
          state: 'working',
          prompt: 'Configurar y entender los comprobantes',
          updatedAt: T0
        })
      )

      // Once a newer shell title arrives after the hook, it retires the working status to done.
      vi.setSystemTime(T0 + 1_000)
      runtime.onPtyData(PTY_ID, '\x1b]0;C:\\WINDOWS\\system32\\cmd.exe\x07', T0 + 1_000)

      expect(await projectAgentStatus(runtime)).toEqual(
        expect.objectContaining({
          state: 'done',
          prompt: '',
          updatedAt: T0 + 1_000
        })
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('mobile session tabs: a permission report after its hook', () => {
  const approval = JSON.stringify({ approval: { tool: 'Bash', summary: 'ls' } })

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function blockAfterApprovalHook(blockedAt: number): Promise<OrcaRuntimeService> {
    vi.setSystemTime(T0)
    const rows: AgentStatusIpcPayload[] = []
    const runtime = await createRuntime(rows)
    runtime.onPtyData(PTY_ID, '\x1b]0;Claude Code\x07\x1b]7501;state=working\x1b\\', T0)
    vi.setSystemTime(T0 + 1_000)
    rows.push({
      paneKey: PANE_KEY,
      state: 'waiting',
      prompt: 'list files',
      agentType: 'claude',
      connectionId: null,
      receivedAt: T0 + 1_000,
      stateStartedAt: T0 + 1_000,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      toolName: 'Bash',
      toolInput: 'ls',
      interactivePrompt: approval
    })
    vi.setSystemTime(blockedAt)
    runtime.onPtyData(PTY_ID, '\x1b]7501;state=blocked:kind=permission\x1b\\', blockedAt)
    return runtime
  }

  it('keeps the approval the PermissionRequest hook published', async () => {
    const runtime = await blockAfterApprovalHook(T0 + 1_050)

    expect(await projectAgentStatus(runtime)).toEqual(
      expect.objectContaining({
        state: 'waiting',
        toolName: 'Bash',
        interactivePrompt: approval,
        stateStartedAt: T0 + 1_000
      })
    )
  })

  it('does not offer that approval for a later block with no hook of its own', async () => {
    const runtime = await blockAfterApprovalHook(T0 + 1_050)
    await projectAgentStatus(runtime)
    vi.setSystemTime(T0 + 2_000)
    runtime.onPtyData(PTY_ID, '\x1b]7501;state=working\x1b\\', T0 + 2_000)
    vi.setSystemTime(T0 + 5_000)
    runtime.onPtyData(PTY_ID, '\x1b]7501;state=blocked:kind=permission\x1b\\', T0 + 5_000)

    const status = await projectAgentStatus(runtime)
    expect(status).not.toHaveProperty('interactivePrompt')
    expect(status).toEqual(expect.objectContaining({ stateStartedAt: T0 + 5_000 }))
  })

  it('does not offer a wait hook from long before a hookless block in the same working interval', async () => {
    const runtime = await blockAfterApprovalHook(T0 + 30_000)

    const status = await projectAgentStatus(runtime)
    expect(status).not.toHaveProperty('interactivePrompt')
    expect(status).toEqual(expect.objectContaining({ stateStartedAt: T0 + 30_000 }))
  })
})

describe('mobile session tabs: identity-only fallback freshness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('dates the identity-only done by its title evidence, not by output bytes', async () => {
    const resumeRow: AgentStatusIpcPayload = {
      paneKey: PANE_KEY,
      state: 'done',
      prompt: '',
      agentType: 'claude',
      connectionId: null,
      receivedAt: T0,
      stateStartedAt: T0,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      providerSession: PROVIDER_SESSION,
      providerSessionOnly: true
    }
    const runtime = await createRuntime([resumeRow])
    runtime.onPtyData(PTY_ID, '\x1b]0;Terminal\x07', T0)
    const titleObservedAt = Date.now()

    // Output without new status evidence must not refresh the identity fallback.
    vi.setSystemTime(T0 + 60_000)
    runtime.onPtyData(PTY_ID, 'building...\r\n', T0 + 60_000)

    const agentStatus = await projectAgentStatus(runtime)
    expect(agentStatus).toEqual(
      expect.objectContaining({
        state: 'done',
        updatedAt: titleObservedAt,
        stateStartedAt: titleObservedAt
      })
    )

    vi.setSystemTime(T0 + 120_000)
    runtime.onPtyData(PTY_ID, 'still building...\r\n', T0 + 120_000)
    expect(await projectAgentStatus(runtime)).toEqual(
      expect.objectContaining({ updatedAt: titleObservedAt })
    )
  })
})

// #46569: quitting an idle agent is no new turn end, so its Done keeps the finished turn's identity.
describe('mobile session tabs: an agent that exits after its turn ended', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the finished turn as the Done after the agent quits or relaunches', async () => {
    const finishedTurn: AgentStatusIpcPayload = {
      paneKey: PANE_KEY,
      state: 'done',
      prompt: 'Reply with the single word hi.',
      agentType: 'pi',
      connectionId: null,
      receivedAt: T0 + 1_000,
      stateStartedAt: T0 + 1_000,
      turnCompletedAt: T0 + 990,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      providerSession: PROVIDER_SESSION
    }
    const rows = [finishedTurn]
    const runtime = await createRuntime(rows, 'pi')
    runtime.onPtyData(PTY_ID, '\x1b]0;\u03c0 - work\x07', T0)

    // The exit retires the live row; only its resume identity stays with the pane.
    vi.setSystemTime(T0 + 60_000)
    rows[0] = { ...finishedTurn, prompt: '', providerSessionOnly: true }
    runtime.onPtyData(PTY_ID, '\x1b]0;zsh\x07', T0 + 60_000)
    expect(await projectTerminalTab(runtime)).toEqual(
      expect.objectContaining({
        turnCompletedAt: T0 + 990,
        agentStatus: expect.objectContaining({ state: 'done', stateStartedAt: T0 + 1_000 })
      })
    )

    // The shell titles the pane with the relaunch command before the agent paints its own.
    vi.setSystemTime(T0 + 90_000)
    runtime.onPtyData(PTY_ID, '\x1b]0;pi --session 01a20155\x07', T0 + 90_000)
    expect(await projectTerminalTab(runtime)).toEqual(
      expect.objectContaining({
        turnCompletedAt: T0 + 990,
        agentStatus: expect.objectContaining({ state: 'done', stateStartedAt: T0 + 1_000 })
      })
    )

    // A turn only the title reports is a new end, even after a replay restamps the old Done's receipt.
    vi.setSystemTime(T0 + 100_000)
    runtime.onPtyData(PTY_ID, '\x1b]0;\u280b \u03c0 - work\x07', T0 + 100_000)
    rows[0] = { ...rows[0]!, receivedAt: T0 + 120_000, evidenceObservedAt: T0 + 1_000 }
    vi.setSystemTime(T0 + 130_000)
    runtime.onPtyData(PTY_ID, '\x1b]0;\u03c0 - work\x07', T0 + 130_000)
    const titleTurn = await projectTerminalTab(runtime)
    expect(titleTurn).not.toHaveProperty('turnCompletedAt')
    expect(titleTurn).toEqual(
      expect.objectContaining({
        agentStatus: expect.objectContaining({ state: 'done', stateStartedAt: T0 + 130_000 })
      })
    )
  })
})

// STA-12043: a restored host starts a new shell in the pane; the old run's Done is not this one's.
describe('mobile session tabs: a process started after its pane last reported', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(['headless', 'published'] as const)(
    'publishes %s identity only after a new process starts',
    async (route) => {
      const completedBeforeRestart: AgentStatusIpcPayload = {
        paneKey: PANE_KEY,
        state: 'done',
        prompt: 'ship it',
        agentType: 'codex',
        connectionId: null,
        receivedAt: T0 - 120_000,
        stateStartedAt: T0 - 120_000,
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        providerSession: PROVIDER_SESSION
      }
      const rows = [completedBeforeRestart]
      const runtime = await createRuntime(rows)
      runtime.noteTerminalSpawnCommit({ id: PTY_ID })
      vi.setSystemTime(T0 + 20)
      runtime.onPtyData(PTY_ID, '\x1b]0;zsh\x07', T0 + 20)
      if (route === 'published') {
        await publishRendererWorkingPane(runtime, 'zsh', {
          state: 'done',
          prompt: '',
          paneKey: PANE_KEY,
          agentType: 'codex',
          updatedAt: T0 - 120_000,
          stateStartedAt: T0 - 120_000,
          stateHistory: [],
          paneSleep: { ptyId: PTY_ID }
        })
      }

      const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
      const tab = result.tabs[0]
      expect(tab?.type === 'terminal' ? tab.agentStatus : null).toEqual(
        expect.objectContaining({ restoredUnconfirmed: true, providerSession: PROVIDER_SESSION })
      )
      const legacy = projectSessionTabAgentStatus(result, 'runtime', []).tabs[0]
      expect(legacy?.type === 'terminal' ? legacy.agentStatus : null).toEqual(
        expect.objectContaining({ state: 'done', providerSession: PROVIDER_SESSION })
      )
      expect(legacy?.type === 'terminal' ? legacy.agentStatus : null).not.toHaveProperty(
        'restoredUnconfirmed'
      )
      rows.length = 0
      expect(await projectAgentStatus(runtime)).toBeUndefined()
      vi.setSystemTime(T0 + 40)
      runtime.onPtyData(PTY_ID, '\x1b]0;⠧ New turn\x07', T0 + 40)
      const successor = await projectAgentStatus(runtime)
      expect(successor?.state).toBe('working')
      expect(successor).not.toHaveProperty('paneSleep')
    }
  )
})

// #39120: Pi ends its reply (OSC 7501 root done) while async pi-subagents children keep the row working.
describe('mobile session tabs: a Pi turn held open by background subagents', () => {
  const subagents = [
    { id: 'child-a', state: 'working' as const, startedAt: T0 + 100, agentType: 'worker' },
    { id: 'child-b', state: 'working' as const, startedAt: T0 + 200, agentType: 'worker' }
  ]
  const heldRow: AgentStatusIpcPayload = {
    paneKey: PANE_KEY,
    state: 'working',
    prompt: 'start two background workers',
    agentType: 'pi',
    connectionId: null,
    receivedAt: T0 + 1_000,
    stateStartedAt: T0,
    tabId: TAB_ID,
    worktreeId: WORKTREE_ID,
    lastAssistantMessage: 'Started the background workers.',
    subagents
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(['headless', 'published'] as const)(
    'keeps the %s row working with its children after the lead reports done',
    async (route) => {
      const rows: AgentStatusIpcPayload[] = []
      const runtime = await createRuntime(rows, 'pi')
      // Bytes captured from Pi 1.5.2 with pi-subagents 0.89.0.
      runtime.onPtyData(
        PTY_ID,
        '\x1b]0;\u280b \u03c0 - work\x07\x1b]7501;state=working:app=pi\x1b\\' +
          '\x1b]7501;state=working:id=subagents/child-a:app=pi-subagents:title=d29ya2Vy\x1b\\' +
          '\x1b]7501;state=working:id=subagents/child-b:app=pi-subagents:title=d29ya2Vy\x1b\\',
        T0
      )
      vi.setSystemTime(T0 + 1_000)
      rows.push(heldRow)
      // The hook can land just before the lead's done reaches the PTY.
      vi.setSystemTime(T0 + 1_001)
      runtime.onPtyData(
        PTY_ID,
        '\x1b]0;\u03c0 - work\x07\x1b]7501;state=done:app=pi\x1b\\',
        T0 + 1_001
      )
      if (route === 'published') {
        await publishRendererWorkingPane(
          runtime,
          '\u03c0 - work',
          {
            state: 'working',
            prompt: heldRow.prompt,
            paneKey: PANE_KEY,
            agentType: 'pi',
            updatedAt: T0 + 1_000,
            stateStartedAt: T0,
            stateHistory: [],
            subagents
          },
          'pi'
        )
      }

      vi.setSystemTime(T0 + 60_000)
      expect(await projectAgentStatus(runtime)).toEqual(
        expect.objectContaining({ state: 'working', subagents })
      )
    }
  )
})
