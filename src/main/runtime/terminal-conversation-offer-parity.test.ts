// One host decision offers a statusless pane's conversation: the builder's neutral-title branch.
// These cases drive the real builder, projection and audience fold, then pin the frames a shipped
// phone (folded status) and a capable phone (field + offer) receive. The mobile half of this test
// (mobile/src/session/terminal-conversation-offer-parity.test.ts) runs the real phone readers on
// the same frames, because root suites must not import mobile sources.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { TERMINAL_CONVERSATION_IDENTITY_CLIENT_CAPABILITY } from '../../shared/protocol-version'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import type { StoredAgentConversationRead } from '../agent-hooks/server/server-types'
import type { RuntimeAgentRowSnapshot } from './runtime-hook-agent-row-selection'
import { buildRuntimeMobileAgentStatus } from './runtime-mobile-agent-status-builder'
import { projectRuntimeMobileSessionTabs } from './runtime-mobile-session-projection'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { projectSessionTabsForClient } from './rpc/methods/session-tabs-inventory'

const NOW = 1_791_108_000_000
const FIXTURE_PATH = join(
  __dirname,
  '../../shared/__fixtures__/terminal-conversation-offer-parity-frames.json'
)
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab:${LEAF}`
const NEUTRAL = 'Say hi | my-repo'
const SESSION = { key: 'session_id' as const, id: 'session-S', transcriptPath: '/r/S.jsonl' }
const TAB: RuntimeMobileSessionTerminalTab = {
  type: 'terminal',
  id: `tab::${LEAF}`,
  parentTabId: 'tab',
  leafId: LEAF,
  title: 'Terminal',
  isActive: true
}

afterEach(() => {
  vi.restoreAllMocks()
})

function ptyRecord(overrides: Partial<RuntimePtyWorktreeRecord> = {}): RuntimePtyWorktreeRecord {
  return {
    tailBuffer: [],
    tailTranscriptBuffer: [],
    tailTranscriptChars: 0,
    tailPartialLine: '',
    tailPendingAnsi: '',
    tailRedrawCursor: null,
    tailTruncated: false,
    tailLinesTotal: 0,
    preview: '',
    waitBlockedAt: null,
    ptyId: 'pty-1',
    incarnationId: null,
    worktreeId: 'wt-1',
    connectionId: null,
    runtimeSessionOwned: true,
    isWsl: null,
    wslDistro: null,
    tabId: 'tab',
    paneKey: PANE_KEY,
    surfaceRecordedAtGraphSequence: 0,
    launchConfig: null,
    launchToken: null,
    launchIncarnationId: null,
    launchAgent: 'codex',
    agentSessionOwners: [],
    foregroundAgent: null,
    connected: true,
    disconnectedAt: null,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: 'idle',
    lastAgentStatusObservedLive: true,
    lastAgentStatusStartedAtEpochMs: NOW - 1_000,
    lastAgentStatusRichInvalidatedAtEpochMs: NOW - 1_000,
    lastOscTitle: NEUTRAL,
    lastOscTitleAt: 2,
    lastOscTitleEpochMs: NOW - 1_000,
    managementTitle: null,
    managementTitleAt: null,
    controllerTitle: null,
    title: null,
    titleUpdatedAt: null,
    lastOutputAt: null,
    ...overrides
  }
}

function leafRecord(paneTitle: string): RuntimeLeafRecord {
  return {
    tabId: 'tab',
    worktreeId: 'wt-1',
    leafId: LEAF,
    paneRuntimeId: 1,
    ptyId: null,
    paneTitle,
    paneTitleUpdatedAt: NOW,
    connected: false,
    writable: false,
    ptyGeneration: 0,
    lastOutputAt: null,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: null,
    lastAgentStatusObservedLive: false,
    lastOscTitle: null,
    lastOscTitleAt: null,
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

function codexRow(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  const receivedAt = NOW - 5_000
  return {
    paneKey: PANE_KEY,
    state: 'done',
    prompt: 'Say hi',
    agentType: 'codex',
    connectionId: null,
    receivedAt,
    stateStartedAt: receivedAt,
    tabId: 'tab',
    worktreeId: 'wt-1',
    providerSession: SESSION,
    ...overrides
  }
}

function retainedFrom(
  row: AgentStatusIpcPayload,
  payload: Partial<RuntimeAgentRowSnapshot['payload']> = {}
): RuntimeAgentRowSnapshot {
  return {
    paneKey: row.paneKey,
    connectionId: null,
    worktreeId: 'wt-1',
    payload: { state: row.state, prompt: row.prompt ?? '', agentType: row.agentType, ...payload },
    stateStartedAt: row.stateStartedAt,
    updatedAt: row.receivedAt,
    ...(row.providerSession ? { providerSession: row.providerSession } : {})
  }
}

type Seed = {
  pty: RuntimePtyWorktreeRecord
  leaf?: RuntimeLeafRecord
  trackedTitle?: string
  rows: AgentStatusIpcPayload[]
  retained: RuntimeAgentRowSnapshot | null
  launchAgent?: 'codex'
  stored?: StoredAgentConversationRead
}

const FACET: StoredAgentConversationRead = {
  facet: { agentType: 'codex', providerSession: SESSION, capturedAt: NOW - 5_000 },
  rowAgent: 'codex',
  rowIsRemnant: false
}

function project(seed: Seed) {
  const leaves = new Map(seed.leaf ? [[`tab::${LEAF}`, seed.leaf]] : [])
  const snapshot: RuntimeMobileSessionTabsSnapshot = {
    worktree: 'wt-1',
    publicationEpoch: 'headless:1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: TAB.id,
    activeTabType: 'terminal',
    tabs: [{ ...TAB, ...(seed.launchAgent ? { launchAgent: seed.launchAgent } : {}) }]
  }
  const projected = projectRuntimeMobileSessionTabs(snapshot, {
    tabs: new Map(),
    leaves,
    ptysById: new Map([[seed.pty.ptyId, seed.pty]]),
    getLiveBrowserTabs: () => new Map(),
    getProviderSessionRows: () => seed.rows,
    getProviderSessionSnapshot: () => seed.rows,
    getStatusSnapshot: () => seed.rows,
    getConversationIdentity: () => seed.stored ?? FACET,
    getLeafKey: (tabId, leafId) => `${tabId}::${leafId}`,
    findPty: () => seed.pty,
    getRetainedStatus: () => seed.retained,
    getTrackedTitle: () => seed.trackedTitle ?? null,
    getTitleDisplayClear: () => null,
    issuePtyHandle: () => 'term-1',
    recordPty: () => seed.pty,
    buildPtyStatus: (pty, tab, handle, retained, getRows) =>
      buildRuntimeMobileAgentStatus(pty, tab, handle, retained, getRows, {
        getPaneKey: () => PANE_KEY,
        getLeaf: () => seed.leaf ?? null,
        getTrackedTitle: () => seed.trackedTitle ?? null
      }),
    sanitizeGroups: () => undefined,
    pruneGroupLayout: () => null,
    collectTabIds: (tabs) => new Set(tabs.map((tab) => tab.id))
  })
  // Why JSON: each phone only ever sees what survived the wire.
  const wire = (clientCapabilities: string[] | undefined) =>
    JSON.parse(
      JSON.stringify(projectSessionTabsForClient(projected, 'mobile', clientCapabilities).tabs[0])
    )
  return {
    oldPhone: wire(undefined),
    capablePhone: wire([TERMINAL_CONVERSATION_IDENTITY_CLIENT_CAPABILITY])
  }
}

const fresh = codexRow()
const CASES: Record<string, { seed: () => Seed; offered: boolean }> = {
  'neutral PTY title under a shell leaf title': {
    offered: true,
    seed: () => ({
      pty: ptyRecord(),
      leaf: leafRecord('zsh'),
      rows: [fresh],
      retained: retainedFrom(fresh),
      launchAgent: 'codex'
    })
  },
  'shell PTY title under a neutral leaf title': {
    offered: false,
    seed: () => ({
      pty: ptyRecord({ lastOscTitle: 'zsh' }),
      leaf: leafRecord(NEUTRAL),
      rows: [fresh],
      retained: retainedFrom(fresh),
      launchAgent: 'codex'
    })
  },
  'shell tracker title over a neutral PTY title': {
    offered: true,
    seed: () => ({
      pty: ptyRecord(),
      trackedTitle: 'zsh',
      rows: [fresh],
      retained: retainedFrom(fresh),
      launchAgent: 'codex'
    })
  },
  'neutral tracker title over a shell PTY title': {
    offered: false,
    seed: () => ({
      pty: ptyRecord({ lastOscTitle: 'zsh' }),
      trackedTitle: NEUTRAL,
      rows: [fresh],
      retained: retainedFrom(fresh),
      launchAgent: 'codex'
    })
  },
  'a retained tool as a live signal': {
    offered: false,
    seed: () => ({
      pty: ptyRecord(),
      rows: [fresh],
      retained: retainedFrom(fresh, { toolName: 'shell' }),
      launchAgent: 'codex'
    })
  },
  'a retained question as a live signal': {
    offered: false,
    seed: () => ({
      pty: ptyRecord(),
      rows: [fresh],
      retained: retainedFrom(fresh, {
        interactivePrompt: JSON.stringify({ questions: [{ question: 'Proceed?' }] })
      }),
      launchAgent: 'codex'
    })
  },
  'the builder early return with a surviving facet': {
    offered: false,
    seed: () => ({
      pty: ptyRecord({ lastAgentStatus: null }),
      rows: [],
      retained: null,
      launchAgent: 'codex'
    })
  },
  'a Claude management PTY title': {
    offered: false,
    seed: () => ({
      pty: ptyRecord({ lastOscTitle: 'claude agents' }),
      rows: [fresh],
      retained: retainedFrom(fresh),
      launchAgent: 'codex'
    })
  },
  'an aged no-launch remnant under a shell title (genuine status without an agent)': {
    offered: false,
    seed: () => ({
      pty: ptyRecord({ lastOscTitle: 'zsh', lastAgentStatus: null, launchAgent: null }),
      rows: [codexRow({ receivedAt: NOW - 31 * 60_000, stateStartedAt: NOW - 31 * 60_000 })],
      retained: null
    })
  },
  'the same remnant with a launch record': {
    offered: false,
    seed: () => ({
      pty: ptyRecord({ lastOscTitle: 'zsh', lastAgentStatus: null }),
      rows: [codexRow({ receivedAt: NOW - 31 * 60_000, stateStartedAt: NOW - 31 * 60_000 })],
      retained: null,
      launchAgent: 'codex'
    })
  }
}

function projectAll() {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  return Object.fromEntries(
    Object.entries(CASES).map(([name, testCase]) => [name, project(testCase.seed())])
  )
}

describe('one host offer decision for every phone', () => {
  it.each(Object.entries(CASES))('%s', (name, testCase) => {
    const { oldPhone, capablePhone } = projectAll()[name]!
    expect(capablePhone).not.toHaveProperty('agentStatus.sessionBoundary')
    if (testCase.offered) {
      expect(capablePhone).toMatchObject({ conversationOfferedWithoutStatus: true })
      expect(capablePhone).not.toHaveProperty('agentStatus')
      expect(oldPhone).toMatchObject({
        agentStatus: { state: 'done', sessionBoundary: true, providerSession: SESSION }
      })
      return
    }
    expect(capablePhone).not.toHaveProperty('conversationOfferedWithoutStatus')
    expect(oldPhone).not.toHaveProperty('agentStatus.sessionBoundary')
    // Why: with no offer both phones see the same status bytes; only the additive field differs.
    expect(oldPhone.agentStatus).toEqual(capablePhone.agentStatus)
  })

  it('pins the frames the mobile half reads', () => {
    expect(`${JSON.stringify(projectAll(), null, 2)}\n`).toBe(readFileSync(FIXTURE_PATH, 'utf8'))
  })
})
