import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { RuntimeMobileSessionTerminalTab } from '../../shared/runtime-types'

const TAB_ID = '258c3b52-ed9c-4494-88d7-8577515b8987'
const LEAF_ID = '57b25db0-75f7-4d6d-90d9-9d1d7b9a3466'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`

const tab: RuntimeMobileSessionTerminalTab = {
  type: 'terminal',
  id: `${TAB_ID}::${LEAF_ID}`,
  // The placeholder a headless host publishes for a pane it holds no live handle for.
  title: 'Terminal',
  parentTabId: TAB_ID,
  leafId: LEAF_ID,
  isActive: false
}

const WORKTREE_ID =
  'cc1bd8a8-6e33-49f4-ae20-be69ba290954::/home/gal/dev/ai-projects::workspace:86c20dd7-9943-42a1-8868-3d71aac6a281'

const hookRow = (state: 'working' | 'waiting' | 'done', now: number): AgentStatusIpcPayload =>
  ({
    paneKey: PANE_KEY,
    state,
    prompt: 'sleep for 10 min',
    agentType: 'codex',
    connectionId: null,
    worktreeId: WORKTREE_ID,
    receivedAt: now,
    stateStartedAt: now - 5_000
  }) as AgentStatusIpcPayload

describe('headless agent status published from hook rows', () => {
  it('publishes the working state the hook reported, not a title-derived done', () => {
    // Reproduces the remote checkmark: hooks fire on the host and record `working`,
    // but the published surface said `done`, so an unfocused tab rendered as idle and
    // no working->done edge ever existed for notifications to fire on.
    const runtime = new OrcaRuntimeService(null) as unknown as {
      buildPtyMobileAgentStatus: (
        pty: null,
        tab: RuntimeMobileSessionTerminalTab,
        terminalHandle: string | null,
        retained: null,
        getHookRowsForPane: (paneKey: string) => AgentStatusIpcPayload[]
      ) => { agentStatus?: { state: string; agentType?: string } }
    }

    const now = Date.now()
    const published = runtime.buildPtyMobileAgentStatus(null, tab, null, null, (paneKey) =>
      paneKey === PANE_KEY ? [hookRow('working', now)] : []
    )

    expect(published.agentStatus?.state).toBe('working')
  })

  it('publishes a waiting hook state and keeps the agent type', () => {
    const runtime = new OrcaRuntimeService(null) as unknown as {
      buildPtyMobileAgentStatus: (
        pty: null,
        tab: RuntimeMobileSessionTerminalTab,
        terminalHandle: string | null,
        retained: null,
        getHookRowsForPane: (paneKey: string) => AgentStatusIpcPayload[]
      ) => { agentStatus?: { state: string; agentType?: string } }
    }

    const now = Date.now()
    const published = runtime.buildPtyMobileAgentStatus(null, tab, null, null, (paneKey) =>
      paneKey === PANE_KEY ? [hookRow('waiting', now)] : []
    )

    expect(published.agentStatus?.state).toBe('waiting')
    expect(published.agentStatus?.agentType).toBe('codex')
  })

  it('still publishes done when the hook says done', () => {
    const runtime = new OrcaRuntimeService(null) as unknown as {
      buildPtyMobileAgentStatus: (
        pty: null,
        tab: RuntimeMobileSessionTerminalTab,
        terminalHandle: string | null,
        retained: null,
        getHookRowsForPane: (paneKey: string) => AgentStatusIpcPayload[]
      ) => { agentStatus?: { state: string } }
    }

    const now = Date.now()
    const published = runtime.buildPtyMobileAgentStatus(null, tab, null, null, (paneKey) =>
      paneKey === PANE_KEY ? [hookRow('done', now)] : []
    )

    expect(published.agentStatus?.state).toBe('done')
  })
})
