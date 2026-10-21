// #28102: a paired client keeps whichever row has the newer `updatedAt`, so the host's
// published stamp for one pane must never move backwards across a turn's end.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { AgentStatusEntry, AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const TAB_ID = 'muse-tab'
const WORKTREE_ID = 'wt-muse'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const PTY_ID = 'pty-muse'
// Hook Stop time; the rest are the deltas from the issue's 200 ms poll of session.tabs.list.
const STOP_AT = 1_700_000_000_000
const TRAILING_SPINNER_AT = STOP_AT + 4_534
const PLAIN_TITLE_AT = STOP_AT + 4_800

async function createRuntime(rows: AgentStatusIpcPayload[]): Promise<OrcaRuntimeService> {
  const runtime = new OrcaRuntimeService(null, undefined, {
    getAgentStatusSnapshot: () => rows
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveTerminalWorkspaceLaunchScope is a member of OrcaRuntimeService; the cast only exposes it to the spy.
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
  runtime: OrcaRuntimeService
): Promise<AgentStatusEntry | null | undefined> {
  const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
  const tab = result.tabs[0]
  return tab?.type === 'terminal' ? tab.agentStatus : undefined
}

describe('session.tabs agent status ordering after a turn ends', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(STOP_AT)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('publishes the final done with a stamp no older than the trailing spinner frame', async () => {
    const stopRow: AgentStatusIpcPayload = {
      paneKey: PANE_KEY,
      state: 'done',
      prompt: 'Reply with just the word OK3',
      agentType: 'claude',
      connectionId: null,
      receivedAt: STOP_AT,
      stateStartedAt: STOP_AT,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      lastAssistantMessage: 'OK3'
    }
    const runtime = await createRuntime([stopRow])

    // The agent keeps animating its title for a few seconds after Stop.
    vi.setSystemTime(TRAILING_SPINNER_AT)
    runtime.onPtyData(PTY_ID, '\x1b]0;⠧ muse\x07', TRAILING_SPINNER_AT)
    const spinning = await projectAgentStatus(runtime)
    expect(spinning).toEqual(
      expect.objectContaining({ state: 'working', updatedAt: TRAILING_SPINNER_AT })
    )

    vi.setSystemTime(PLAIN_TITLE_AT)
    runtime.onPtyData(PTY_ID, '\x1b]0;muse\x07', PLAIN_TITLE_AT)
    const settled = await projectAgentStatus(runtime)
    expect(settled?.state).toBe('done')
    expect(settled?.updatedAt).toBeGreaterThanOrEqual(TRAILING_SPINNER_AT)
    // Freshness still dates from the Stop hook, not from the title repaint.
    expect(settled?.evidenceObservedAt).toBe(STOP_AT)
  })
})
