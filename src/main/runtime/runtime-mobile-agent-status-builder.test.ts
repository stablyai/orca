import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { RuntimeMobileSessionTerminalTab } from '../../shared/runtime-types'
import type { RuntimeAgentRowSnapshot } from './runtime-hook-agent-row-selection'
import { buildRuntimeMobileAgentStatus } from './runtime-mobile-agent-status-builder'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'

const PROVIDER_SESSION = { key: 'session_id' as const, id: 'session-1' }
const TAB: RuntimeMobileSessionTerminalTab = {
  type: 'terminal',
  id: 'tab::leaf',
  parentTabId: 'tab',
  leafId: 'leaf',
  title: 'Terminal',
  isActive: true
}

describe('mobile agent status builder', () => {
  it('keeps provider-session identity from a terminal-handle row rejoin', () => {
    const retained: RuntimeAgentRowSnapshot = {
      paneKey: 'old-tab:old-leaf',
      connectionId: null,
      payload: { state: 'working', prompt: 'ship it', agentType: 'codex' },
      stateStartedAt: 10,
      updatedAt: 10,
      providerSession: PROVIDER_SESSION
    }

    const result = buildRuntimeMobileAgentStatus(null, TAB, 'term-1', retained, () => [], {
      getPaneKey: () => 'new-tab:new-leaf',
      getLeaf: () => null,
      getTrackedTitle: () => null
    })

    expect(result).toEqual(
      expect.objectContaining({
        agentStatus: expect.objectContaining({ providerSession: PROVIDER_SESSION })
      })
    )
  })
})

// A synced leaf projects with no PTY record of its own, so a shell title it painted after a
// restored turn must still retire that turn through the leaf's PTY title clock.
const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const PTY_ID = 'pty-1'

const LEAF_TAB: RuntimeMobileSessionTerminalTab = {
  type: 'terminal',
  id: `${TAB_ID}::${LEAF_ID}`,
  title: 'Terminal 1',
  parentTabId: TAB_ID,
  leafId: LEAF_ID,
  isActive: true
}

function leafWithTitle(lastOscTitle: string | null): RuntimeLeafRecord {
  return {
    tabId: TAB_ID,
    worktreeId: 'wt-1',
    leafId: LEAF_ID,
    paneRuntimeId: 1,
    ptyId: PTY_ID,
    paneTitle: null,
    title: null,
    ptyGeneration: 1,
    connected: true,
    writable: true,
    lastOutputAt: null,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: null,
    lastAgentStatusObservedLive: false,
    lastOscTitle,
    lastOscTitleAt: lastOscTitle ? 1 : null,
    paneTitleUpdatedAt: null,
    tailBuffer: [],
    tailTranscriptBuffer: [],
    tailTranscriptChars: 0,
    tailPartialLine: '',
    tailPendingAnsi: '',
    tailRedrawCursor: null,
    tailTruncated: false,
    tailLinesTotal: 0,
    preview: '',
    waitBlockedAt: null
  }
}

function restoredRow(receivedAt: number): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    state: 'working',
    prompt: 'refactor the parser',
    agentType: 'claude',
    connectionId: null,
    receivedAt,
    stateStartedAt: receivedAt,
    tabId: TAB_ID,
    worktreeId: 'wt-1',
    restoredUnconfirmed: true
  }
}

function project(leaf: RuntimeLeafRecord, titleEpochMs: number | null, receivedAt: number) {
  return buildRuntimeMobileAgentStatus(
    null,
    LEAF_TAB,
    null,
    null,
    () => [restoredRow(receivedAt)],
    {
      getPaneKey: () => PANE_KEY,
      getLeaf: () => leaf,
      getTrackedTitle: () => null,
      getPtyTitleObservedAtEpochMs: (ptyId) => (ptyId === PTY_ID ? titleEpochMs : null)
    }
  )
}

describe('restored turns on a synced leaf', () => {
  it('stays unverifiable when only a seeded (unclocked) shell title is known', () => {
    const receivedAt = Date.now() - 60_000
    const result = project(leafWithTitle('bash'), null, receivedAt)

    expect(result.agentStatus).toEqual(
      expect.objectContaining({ state: 'working', restoredUnconfirmed: true })
    )
  })

  it('stays unverifiable under a newer title that is not a shell', () => {
    const receivedAt = Date.now() - 60_000
    const result = project(leafWithTitle('vim'), receivedAt + 1_000, receivedAt)

    expect(result.agentStatus).toEqual(
      expect.objectContaining({ state: 'working', restoredUnconfirmed: true })
    )
  })

  it('retires to done once the leaf PTY paints a newer shell title', () => {
    const receivedAt = Date.now() - 60_000
    const result = project(leafWithTitle('bash'), receivedAt + 1_000, receivedAt)

    expect(result.agentStatus?.state).toBe('done')
    expect(result.agentStatus).not.toHaveProperty('restoredUnconfirmed')
  })
})
