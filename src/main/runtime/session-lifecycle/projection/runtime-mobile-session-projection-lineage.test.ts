import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { RuntimeMobileSessionTerminalTab } from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import type { RuntimePtyWorktreeRecord } from '../../terminal/records/runtime-terminal-state-records'
import { buildRuntimeMobileAgentStatus } from './runtime-mobile-agent-status-builder'
import {
  demoteRuntimeMobileAgentStatus,
  renewRuntimeMobileAgentStatusFromPtyTitle
} from './runtime-mobile-agent-status-projection'
import { projectRuntimeMobileSessionTabs } from './runtime-mobile-session-projection'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'

const TAB_ID = 'tab-worker'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const ORCHESTRATION = {
  taskId: 'task-1',
  dispatchId: 'dispatch-1',
  parentTerminalHandle: 'term_coordinator',
  parentPaneKey: `tab-coordinator:${LEAF_ID}`,
  coordinatorHandle: 'term_coordinator'
}

function workingWorkerRow(updatedAt: number): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'resident task',
    agentType: 'claude',
    paneKey: PANE_KEY,
    terminalHandle: 'term_worker',
    updatedAt,
    stateStartedAt: updatedAt,
    stateHistory: [],
    orchestration: ORCHESTRATION
  }
}

function workingTitlePty(titleAt: number): RuntimePtyWorktreeRecord {
  return {
    ptyId: 'pty-worker',
    incarnationId: null,
    worktreeId: 'wt-1',
    connectionId: null,
    runtimeSessionOwned: false,
    isWsl: null,
    wslDistro: null,
    launchConfig: null,
    launchToken: null,
    launchIncarnationId: null,
    launchAgent: null,
    launchCommandAgent: null,
    agentSessionOwners: [],
    foregroundAgent: null,
    connected: true,
    disconnectedAt: null,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: 'working',
    lastAgentStatusObservedLive: true,
    lastAgentStatusStartedAtEpochMs: titleAt,
    lastAgentStatusRichInvalidatedAtEpochMs: null,
    lastOscTitle: '✳ Claude Code',
    lastOscTitleAt: 1,
    lastOscTitleEpochMs: titleAt,
    managementTitle: null,
    managementTitleAt: null,
    controllerTitle: null,
    title: null,
    titleUpdatedAt: null,
    lastOutputAt: null,
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

function hostWithFinishedHookRow(now: number): RuntimeMobileSessionProjectionHost {
  const hookRow: AgentStatusIpcPayload = {
    state: 'done',
    prompt: 'resident task',
    agentType: 'claude',
    paneKey: PANE_KEY,
    connectionId: null,
    receivedAt: now - 1_000,
    stateStartedAt: now - 1_000
  }
  return {
    tabs: new Map(),
    leaves: new Map(),
    ptysById: new Map(),
    getPtyAvailability: () => null,
    isSessionTitlePublisher: () => false,
    getLiveBrowserTabs: () => new Map(),
    isRendererOwnedMobileBrowserTab: () => false,
    getProviderSessionRows: (paneKey) => (paneKey === PANE_KEY ? [hookRow] : []),
    getProviderSessionSnapshot: () => [],
    getStatusRows: () => [],
    getLeafKey: (tabId, leafId) => `${tabId}\0${leafId}`,
    findPty: () => null,
    getRetainedStatus: () => null,
    getTrackedTitle: () => null,
    isUntypedFreshSpawn: () => false,
    getTitleDisplayClear: () => null,
    issuePtyHandle: () => {
      throw new Error('no live pty in this fixture')
    },
    recordPty: () => {
      throw new Error('no live pty in this fixture')
    },
    buildPtyStatus: (pty, tab, terminalHandle, retained, getRows) =>
      buildRuntimeMobileAgentStatus(pty, tab, terminalHandle, retained, getRows, {
        getPaneKey: () => PANE_KEY,
        getLeaf: () => null,
        getTrackedTitle: () => null
      }),
    sanitizeGroups: (groups) => groups,
    pruneGroupLayout: (layout) => layout ?? null,
    collectTabIds: (tabs) => new Set(tabs.map((tab) => tab.id))
  }
}

// Why a fixed clock: the projection compares row ages against the current time.
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0)

describe('paired-client frame lineage identity', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the renderer row terminal handle and dispatch lineage once its turn is done', () => {
    const now = NOW
    const rendererRow: AgentStatusEntry = {
      state: 'done',
      prompt: 'resident task',
      agentType: 'claude',
      paneKey: PANE_KEY,
      terminalHandle: 'term_worker',
      updatedAt: now - 1_000,
      stateStartedAt: now - 1_000,
      stateHistory: [],
      orchestration: ORCHESTRATION
    }
    const tab: RuntimeMobileSessionTerminalTab = {
      type: 'terminal',
      id: `${TAB_ID}::${LEAF_ID}`,
      title: 'Claude Code',
      parentTabId: TAB_ID,
      leafId: LEAF_ID,
      isActive: true,
      agentStatus: rendererRow
    }

    const result = projectRuntimeMobileSessionTabs(
      {
        worktree: 'wt-1',
        publicationEpoch: 'desktop:1',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: tab.id,
        activeTabType: 'terminal',
        tabs: [tab]
      },
      hostWithFinishedHookRow(now)
    )

    const projected = result.tabs.find((candidate) => candidate.type === 'terminal')
    expect(projected?.type === 'terminal' ? projected.agentStatus : undefined).toMatchObject({
      state: 'done',
      terminalHandle: 'term_worker',
      orchestration: ORCHESTRATION
    })
  })

  it('keeps lineage when a shell title demotes a working row', () => {
    expect(demoteRuntimeMobileAgentStatus(workingWorkerRow(NOW), null)).toMatchObject({
      state: 'done',
      terminalHandle: 'term_worker',
      orchestration: ORCHESTRATION
    })
  })

  it('keeps lineage when a stale working row is rebuilt from its title', () => {
    const now = NOW
    const renewed = renewRuntimeMobileAgentStatusFromPtyTitle(
      workingWorkerRow(now - AGENT_STATUS_STALE_AFTER_MS - 60_000),
      workingTitlePty(now)
    )
    expect(renewed).toMatchObject({
      state: 'working',
      updatedAt: now,
      terminalHandle: 'term_worker',
      orchestration: ORCHESTRATION
    })
  })
})
