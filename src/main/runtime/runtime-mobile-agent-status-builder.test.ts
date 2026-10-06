import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { readMobileConversationIdentityCarrier } from './mobile-conversation-identity-carrier'
import type { RuntimeAgentRowSnapshot } from './runtime-hook-agent-row-selection'
import { buildRuntimeMobileAgentStatus } from './runtime-mobile-agent-status-builder'
import { projectRuntimeMobileSessionTabs } from './runtime-mobile-session-projection'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { projectSessionTabsForClient } from './rpc/methods/session-tabs-inventory'

const PROVIDER_SESSION = { key: 'session_id' as const, id: 'session-1' }
const TAB: RuntimeMobileSessionTerminalTab = {
  type: 'terminal',
  id: 'tab::leaf',
  parentTabId: 'tab',
  leafId: 'leaf',
  title: 'Terminal',
  isActive: true
}
const PANE_KEY = 'tab:leaf'
const CODEX_SESSION = {
  key: 'session_id' as const,
  id: 'ac1f6b90-2f77-4f0e-9c5e-1d2f6a4b8c31',
  transcriptPath: '/codex/sessions/rollout-ac1f6b90.jsonl'
}
const NEUTRAL_TITLE = 'Say hi | my-repo'
const HOST = {
  getPaneKey: () => PANE_KEY,
  getLeaf: () => null,
  getTrackedTitle: () => null
}

function ptyRecord(overrides: Partial<RuntimePtyWorktreeRecord> = {}): RuntimePtyWorktreeRecord {
  const now = Date.now()
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
    lastAgentStatusStartedAtEpochMs: now - 1_000,
    lastAgentStatusRichInvalidatedAtEpochMs: now - 1_000,
    lastOscTitle: NEUTRAL_TITLE,
    lastOscTitleAt: 2,
    lastOscTitleEpochMs: now - 1_000,
    managementTitle: null,
    managementTitleAt: null,
    controllerTitle: null,
    title: null,
    titleUpdatedAt: null,
    lastOutputAt: null,
    ...overrides
  }
}

function codexRow(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
  const receivedAt = Date.now() - 5_000
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
    providerSession: CODEX_SESSION,
    ...overrides
  }
}

function retainedFrom(row: AgentStatusIpcPayload): RuntimeAgentRowSnapshot {
  return {
    paneKey: row.paneKey,
    connectionId: null,
    ...(row.worktreeId ? { worktreeId: row.worktreeId } : {}),
    payload: { state: row.state, prompt: row.prompt ?? '', agentType: row.agentType },
    stateStartedAt: row.stateStartedAt,
    updatedAt: row.receivedAt,
    ...(row.providerSession ? { providerSession: row.providerSession } : {})
  }
}

type RowCase = 'fresh retained' | 'aged' | 'providerSessionOnly remnant'

function rowCase(kind: RowCase): {
  rows: AgentStatusIpcPayload[]
  retained: RuntimeAgentRowSnapshot | null
  observedAt: number
} {
  if (kind === 'fresh retained') {
    const row = codexRow()
    return { rows: [row], retained: retainedFrom(row), observedAt: row.receivedAt }
  }
  // Why 31 min: past AGENT_STATUS_STALE_AFTER_MS, so the row proves identity but no live state.
  const agedAt = Date.now() - 31 * 60_000
  const row =
    kind === 'aged'
      ? codexRow({ receivedAt: agedAt, stateStartedAt: agedAt })
      : codexRow({
          providerSessionOnly: true,
          receivedAt: agedAt,
          stateStartedAt: agedAt,
          prompt: ''
        })
  return { rows: [row], retained: null, observedAt: agedAt }
}

function build(args: {
  rows: AgentStatusIpcPayload[]
  retained: RuntimeAgentRowSnapshot | null
  pty?: RuntimePtyWorktreeRecord
  tab?: RuntimeMobileSessionTerminalTab
}): ReturnType<typeof buildRuntimeMobileAgentStatus> {
  return buildRuntimeMobileAgentStatus(
    args.pty ?? ptyRecord(),
    args.tab ?? { ...TAB, launchAgent: 'codex' },
    'term-1',
    args.retained,
    () => args.rows,
    HOST
  )
}

function expectedCarrier(observedAt: number, agentType: string = 'codex'): Record<string, unknown> {
  return {
    state: 'done',
    sessionBoundary: true,
    prompt: '',
    updatedAt: observedAt,
    stateStartedAt: observedAt,
    stateHistory: [],
    paneKey: PANE_KEY,
    tabId: 'tab',
    terminalTitle: NEUTRAL_TITLE,
    agentType,
    providerSession: CODEX_SESSION,
    terminalHandle: 'term-1',
    worktreeId: 'wt-1'
  }
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

describe('idle neutral-title conversation identity (STA-7370)', () => {
  it.each<RowCase>(['fresh retained', 'aged', 'providerSessionOnly remnant'])(
    'relays a %s Codex session as a completion-neutral carrier, not as agentStatus',
    (kind) => {
      const input = rowCase(kind)
      const first = build(input)
      const second = build(input)

      expect(first).not.toHaveProperty('agentStatus')
      const carrier = readMobileConversationIdentityCarrier(first)
      expect(carrier).toEqual(expectedCarrier(input.observedAt))
      for (const field of [
        'toolName',
        'toolInput',
        'interactivePrompt',
        'interrupted',
        'turnCompletedAt',
        'mainAgent',
        'lastAssistantMessage'
      ]) {
        expect(carrier).not.toHaveProperty(field)
      }
      expect(readMobileConversationIdentityCarrier(second)).toEqual(carrier)
    }
  )

  it.each(['zsh', 'bash', 'claude agents'])(
    'keeps returning nothing under the shell or management title %s',
    (title) => {
      const result = build({
        ...rowCase('fresh retained'),
        pty: ptyRecord({ lastOscTitle: title })
      })
      expect(result).toEqual({})
      expect(readMobileConversationIdentityCarrier(result)).toBeNull()
    }
  )

  it('returns nothing under a neutral title when the pane holds no conversation identity', () => {
    const row = codexRow({ providerSession: undefined })
    const result = build({ rows: [row], retained: retainedFrom(row) })
    expect(result).toEqual({})
    expect(readMobileConversationIdentityCarrier(result)).toBeNull()
  })

  it('carries the model reported on the hook row that holds the session', () => {
    const row = codexRow({ model: 'gpt-5.5', modelSwitchCommand: 'orca-model' })
    const carrier = readMobileConversationIdentityCarrier(build({ rows: [row], retained: null }))
    expect(carrier).toMatchObject({ model: 'gpt-5.5', modelSwitchCommand: 'orca-model' })
  })

  it('carries the model reported on the retained row when it holds the session', () => {
    const row = codexRow({ model: 'gpt-5.5' })
    const retained = {
      ...retainedFrom(row),
      payload: { ...retainedFrom(row).payload, model: 'gpt-5.5' }
    }
    const carrier = readMobileConversationIdentityCarrier(build({ rows: [], retained }))
    expect(carrier).toMatchObject({ model: 'gpt-5.5', providerSession: CODEX_SESSION })
    expect(carrier).not.toHaveProperty('modelSwitchCommand')
  })

  it('omits the model when the session row reports none, even if another row does', () => {
    const sessionRow = codexRow()
    const newerModelRow = codexRow({
      providerSession: undefined,
      model: 'gpt-5.5',
      receivedAt: sessionRow.receivedAt + 1
    })
    const carrier = readMobileConversationIdentityCarrier(
      build({ rows: [sessionRow, newerModelRow], retained: null })
    )
    expect(carrier?.providerSession).toEqual(CODEX_SESSION)
    expect(carrier).not.toHaveProperty('model')
    expect(carrier).not.toHaveProperty('modelSwitchCommand')
  })

  it('keeps a live tool under a neutral title as rich status, exactly as before', () => {
    const row = codexRow({ state: 'working', toolName: 'shell', prompt: 'Say hi' })
    const retained = {
      ...retainedFrom(row),
      payload: { ...retainedFrom(row).payload, toolName: 'shell' }
    }
    const pty = ptyRecord()
    const result = build({ rows: [row], retained, pty })
    expect(readMobileConversationIdentityCarrier(result)).toBeNull()
    expect(result).toEqual({
      agentStatus: {
        state: 'done',
        prompt: '',
        updatedAt: pty.lastOscTitleEpochMs ?? 0,
        stateStartedAt: expect.any(Number),
        paneKey: PANE_KEY,
        stateHistory: [],
        agentType: 'codex',
        terminalHandle: 'term-1',
        worktreeId: 'wt-1',
        tabId: 'tab',
        terminalTitle: NEUTRAL_TITLE,
        providerSession: CODEX_SESSION
      }
    })
  })

  it('keeps a current question under a neutral title as rich status', () => {
    const interactivePrompt = JSON.stringify({ questions: [{ question: 'Proceed?' }] })
    const row = codexRow({
      state: 'waiting',
      receivedAt: Date.now(),
      stateStartedAt: Date.now(),
      interactivePrompt
    })
    const result = build({ rows: [row], retained: null })
    expect(readMobileConversationIdentityCarrier(result)).toBeNull()
    expect(result).toMatchObject({
      agentStatus: { state: 'waiting', interactivePrompt, providerSession: CODEX_SESSION }
    })
  })

  it('leaves a Claude idle-glyph pane on its existing status path', () => {
    const row = codexRow({ agentType: 'claude', providerSession: PROVIDER_SESSION })
    const result = build({
      rows: [row],
      retained: retainedFrom(row),
      pty: ptyRecord({ lastOscTitle: '✳ Claude Code', launchAgent: 'claude' }),
      tab: { ...TAB, launchAgent: 'claude' }
    })
    expect(readMobileConversationIdentityCarrier(result)).toBeNull()
    expect(result).toMatchObject({
      agentStatus: { state: 'done', agentType: 'claude', providerSession: PROVIDER_SESSION }
    })
    expect(result).not.toHaveProperty('agentStatus.sessionBoundary')
  })

  describe('owner and compatibility', () => {
    const rowCases: RowCase[] = ['fresh retained', 'aged', 'providerSessionOnly remnant']
    const ownerCases: {
      name: string
      launchAgent: TuiAgent | undefined
      expected: string | null
    }[] = [
      { name: 'no launch or foreground owner', launchAgent: undefined, expected: 'codex' },
      { name: 'a compatible launch', launchAgent: 'codex', expected: 'codex' },
      { name: 'an incompatible Claude launch', launchAgent: 'claude', expected: null }
    ]
    for (const kind of rowCases) {
      it.each(ownerCases)(`${kind} row with $name`, ({ launchAgent, expected }) => {
        const input = rowCase(kind)
        const result = build({
          ...input,
          pty: ptyRecord({ launchAgent: launchAgent ?? null }),
          tab: { ...TAB, ...(launchAgent ? { launchAgent } : {}) }
        })
        const carrier = readMobileConversationIdentityCarrier(result)
        if (expected === null) {
          expect(result).toEqual({})
          expect(carrier).toBeNull()
          return
        }
        expect(carrier?.agentType).toBe(expected)
        expect(carrier?.providerSession).toEqual(CODEX_SESSION)
      })
    }

    it('names the launch owner when the session came from a compatible wrapped agent', () => {
      const row = codexRow({ agentType: 'pi' })
      const result = build({
        rows: [row],
        retained: null,
        pty: ptyRecord({ launchAgent: 'omp' }),
        tab: { ...TAB, launchAgent: 'omp' }
      })
      expect(readMobileConversationIdentityCarrier(result)).toMatchObject({
        agentType: 'omp',
        providerSession: CODEX_SESSION
      })
    })

    it('rejects a session from another provider than the foreground agent', () => {
      const input = rowCase('aged')
      const result = build({
        ...input,
        pty: ptyRecord({ launchAgent: null, foregroundAgent: 'claude' }),
        tab: TAB
      })
      expect(result).toEqual({})
    })
  })
})

describe('conversation identity handoff through the real session projection', () => {
  function projectionHost(
    pty: RuntimePtyWorktreeRecord,
    rows: AgentStatusIpcPayload[],
    retained: RuntimeAgentRowSnapshot | null
  ): RuntimeMobileSessionProjectionHost {
    return {
      tabs: new Map(),
      leaves: new Map(),
      ptysById: new Map([[pty.ptyId, pty]]),
      getLiveBrowserTabs: () => new Map(),
      getProviderSessionRows: () => rows,
      getProviderSessionSnapshot: () => rows,
      getStatusSnapshot: () => rows,
      getLeafKey: (tabId, leafId) => `${tabId}::${leafId}`,
      findPty: () => pty,
      getRetainedStatus: () => retained,
      getTrackedTitle: () => null,
      getTitleDisplayClear: () => null,
      issuePtyHandle: () => 'term-1',
      recordPty: () => pty,
      buildPtyStatus: (statusPty, tab, terminalHandle, retainedRow, getRows) =>
        buildRuntimeMobileAgentStatus(statusPty, tab, terminalHandle, retainedRow, getRows, HOST),
      sanitizeGroups: () => undefined,
      pruneGroupLayout: () => null,
      collectTabIds: (tabs) => new Set(tabs.map((tab) => tab.id))
    }
  }

  it('hands the builder carrier to the final tab and only the phone audience publishes it', () => {
    const input = rowCase('fresh retained')
    const snapshotTab: RuntimeMobileSessionTerminalTab = { ...TAB, launchAgent: 'codex' }
    const snapshot: RuntimeMobileSessionTabsSnapshot = {
      worktree: 'wt-1',
      publicationEpoch: 'headless:1',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: snapshotTab.id,
      activeTabType: 'terminal',
      tabs: [snapshotTab]
    }
    const before = structuredClone(snapshot)

    const projected = projectRuntimeMobileSessionTabs(
      snapshot,
      projectionHost(ptyRecord(), input.rows, input.retained)
    )
    const projectedTab = projected.tabs[0]
    const carrier = readMobileConversationIdentityCarrier(projectedTab)
    expect(carrier).toEqual(expectedCarrier(input.observedAt))
    expect(projectedTab).not.toHaveProperty('agentStatus')

    const mobile = projectSessionTabsForClient(projected, 'mobile', undefined)
    expect(mobile.tabs[0]).toMatchObject({ agentStatus: carrier })
    expect(Object.getOwnPropertySymbols(mobile.tabs[0])).toEqual([])

    const runtime = projectSessionTabsForClient(projected, 'runtime', undefined)
    expect(runtime.tabs[0]).not.toHaveProperty('agentStatus')
    expect(Object.getOwnPropertySymbols(runtime.tabs[0])).toEqual([])

    expect(snapshot).toEqual(before)
    expect(Object.getOwnPropertySymbols(snapshot.tabs[0])).toEqual([])
  })

  it('hands no carrier on under a shell title', () => {
    const projected = projectRuntimeMobileSessionTabs(
      {
        worktree: 'wt-1',
        publicationEpoch: 'headless:1',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: TAB.id,
        activeTabType: 'terminal',
        tabs: [{ ...TAB, launchAgent: 'codex' }]
      },
      projectionHost(ptyRecord({ lastOscTitle: 'zsh' }), rowCase('aged').rows, null)
    )
    expect(readMobileConversationIdentityCarrier(projected.tabs[0])).toBeNull()
    expect(projected.tabs[0]).not.toHaveProperty('agentStatus')
  })
})
