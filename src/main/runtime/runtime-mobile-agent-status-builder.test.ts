import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { StoredAgentConversationRead } from '../agent-hooks/server/server-types'
import { TERMINAL_CONVERSATION_IDENTITY_CLIENT_CAPABILITY } from '../../shared/protocol-version'
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

/** The shape #25358's private carrier had; shipped phones still receive exactly this. */
function expectedFold(observedAt: number, agentType: string = 'codex'): Record<string, unknown> {
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

describe('idle neutral-title offer (STA-7370)', () => {
  it.each<RowCase>(['fresh retained', 'aged', 'providerSessionOnly remnant'])(
    'offers a %s Codex conversation without status and computes no identity itself',
    (kind) => {
      const input = rowCase(kind)
      expect(build(input)).toEqual({ offersConversationWithoutStatus: true })
    }
  )

  it.each(['zsh', 'bash', 'claude agents'])(
    'offers nothing under the shell or management title %s',
    (title) => {
      const result = build({
        ...rowCase('fresh retained'),
        pty: ptyRecord({ lastOscTitle: title })
      })
      expect(result).toEqual({})
    }
  )

  it('keeps offering under a neutral title even when the pane holds no identity', () => {
    const row = codexRow({ providerSession: undefined })
    // Why: eligibility is the builder's; the projection publishes the offer only beside an identity.
    expect(build({ rows: [row], retained: retainedFrom(row) })).toEqual({
      offersConversationWithoutStatus: true
    })
  })

  it('keeps a live tool under a neutral title as rich status, exactly as before', () => {
    const row = codexRow({ state: 'working', toolName: 'shell', prompt: 'Say hi' })
    const retained = {
      ...retainedFrom(row),
      payload: { ...retainedFrom(row).payload, toolName: 'shell' }
    }
    const pty = ptyRecord()
    const result = build({ rows: [row], retained, pty })
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
    expect(result).not.toHaveProperty('offersConversationWithoutStatus')
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
    expect(result).not.toHaveProperty('offersConversationWithoutStatus')
    expect(result).toMatchObject({
      agentStatus: { state: 'done', agentType: 'claude', providerSession: PROVIDER_SESSION }
    })
    expect(result).not.toHaveProperty('agentStatus.sessionBoundary')
  })
})

describe('conversation identity through the real session projection', () => {
  function projectionHost(
    pty: RuntimePtyWorktreeRecord,
    rows: AgentStatusIpcPayload[],
    retained: RuntimeAgentRowSnapshot | null,
    stored?: StoredAgentConversationRead
  ): RuntimeMobileSessionProjectionHost {
    return {
      tabs: new Map(),
      leaves: new Map(),
      ptysById: new Map([[pty.ptyId, pty]]),
      getLiveBrowserTabs: () => new Map(),
      getProviderSessionRows: () => rows,
      getProviderSessionSnapshot: () => rows,
      getStatusSnapshot: () => rows,
      getConversationIdentity: () => stored,
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

  function snapshotFor(tab: RuntimeMobileSessionTerminalTab): RuntimeMobileSessionTabsSnapshot {
    return {
      worktree: 'wt-1',
      publicationEpoch: 'headless:1',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: tab.id,
      activeTabType: 'terminal',
      tabs: [tab]
    }
  }

  function project(args: {
    rows: AgentStatusIpcPayload[]
    retained: RuntimeAgentRowSnapshot | null
    pty?: RuntimePtyWorktreeRecord
    tab?: RuntimeMobileSessionTerminalTab
    stored?: StoredAgentConversationRead
  }) {
    return projectRuntimeMobileSessionTabs(
      snapshotFor(args.tab ?? { ...TAB, launchAgent: 'codex' }),
      projectionHost(args.pty ?? ptyRecord(), args.rows, args.retained, args.stored)
    )
  }

  it.each<RowCase>(['fresh retained', 'aged', 'providerSessionOnly remnant'])(
    'publishes a %s row identity and offer; only a capability-less phone gets the fold',
    (kind) => {
      const input = rowCase(kind)
      const snapshot = snapshotFor({ ...TAB, launchAgent: 'codex' })
      const before = structuredClone(snapshot)
      const projected = projectRuntimeMobileSessionTabs(
        snapshot,
        projectionHost(ptyRecord(), input.rows, input.retained)
      )
      const projectedTab = projected.tabs[0]
      expect(projectedTab).not.toHaveProperty('agentStatus')
      expect(projectedTab).toMatchObject({
        conversationIdentity: {
          agentType: 'codex',
          providerSession: CODEX_SESSION,
          capturedAt: input.observedAt,
          source: 'legacy-row'
        },
        conversationOfferedWithoutStatus: true
      })

      const oldPhone = projectSessionTabsForClient(projected, 'mobile', undefined)
      expect(oldPhone.tabs[0]).toMatchObject({ agentStatus: expectedFold(input.observedAt) })
      for (const field of [
        'toolName',
        'toolInput',
        'interactivePrompt',
        'interrupted',
        'turnCompletedAt',
        'mainAgent',
        'lastAssistantMessage'
      ]) {
        expect(oldPhone.tabs[0]).not.toHaveProperty(`agentStatus.${field}`)
      }
      const capablePhone = projectSessionTabsForClient(projected, 'mobile', [
        TERMINAL_CONVERSATION_IDENTITY_CLIENT_CAPABILITY
      ])
      expect(capablePhone.tabs[0]).not.toHaveProperty('agentStatus')
      expect(capablePhone.tabs[0]).toMatchObject({ conversationOfferedWithoutStatus: true })
      const runtime = projectSessionTabsForClient(projected, 'runtime', undefined)
      expect(runtime.tabs[0]).not.toHaveProperty('agentStatus')
      expect(runtime.tabs[0]).toMatchObject({ conversationOfferedWithoutStatus: true })
      expect(snapshot).toEqual(before)
    }
  )

  it('publishes the identity but no offer under a shell title', () => {
    const projected = project({
      ...rowCase('aged'),
      pty: ptyRecord({ lastOscTitle: 'zsh' })
    })
    expect(projected.tabs[0]).not.toHaveProperty('agentStatus')
    expect(projected.tabs[0]).not.toHaveProperty('conversationOfferedWithoutStatus')
    expect(projected.tabs[0]).toMatchObject({
      conversationIdentity: { providerSession: CODEX_SESSION }
    })
    const oldPhone = projectSessionTabsForClient(projected, 'mobile', undefined)
    expect(oldPhone.tabs[0]).not.toHaveProperty('agentStatus')
  })

  it('publishes no offer when the pane holds no identity', () => {
    const row = codexRow({ providerSession: undefined })
    const projected = project({ rows: [row], retained: retainedFrom(row) })
    expect(projected.tabs[0]).not.toHaveProperty('conversationIdentity')
    expect(projected.tabs[0]).not.toHaveProperty('conversationOfferedWithoutStatus')
  })

  it('takes the model from the same row as the session', () => {
    const row = codexRow({ model: 'gpt-5.5', modelSwitchCommand: 'orca-model' })
    expect(project({ rows: [row], retained: null }).tabs[0]).toMatchObject({
      conversationIdentity: { model: 'gpt-5.5', modelSwitchCommand: 'orca-model' }
    })
    const sessionRow = codexRow()
    const newerModelRow = codexRow({
      providerSession: undefined,
      model: 'gpt-5.5',
      receivedAt: sessionRow.receivedAt + 1
    })
    const identity = project({ rows: [sessionRow, newerModelRow], retained: null }).tabs[0]
    expect(identity).toHaveProperty('conversationIdentity.providerSession', CODEX_SESSION)
    expect(identity).not.toHaveProperty('conversationIdentity.model')
  })

  it('prefers the stored facet to any legacy row, and its remnant flag sets the source', () => {
    const facet = {
      agentType: 'codex',
      providerSession: { key: 'session_id' as const, id: 'facet-S' },
      model: 'gpt-5.5',
      capturedAt: 1234
    }
    for (const rowIsRemnant of [false, true]) {
      const tab = project({
        ...rowCase('aged'),
        stored: { facet, rowAgent: 'codex', rowIsRemnant }
      }).tabs[0]
      expect(tab).toMatchObject({
        conversationIdentity: { ...facet, source: rowIsRemnant ? 'retained' : 'live' },
        conversationOfferedWithoutStatus: true
      })
    }
  })

  it("publishes neither member for a facet of another agent than the pane's", () => {
    const codexFacet = {
      agentType: 'codex',
      providerSession: CODEX_SESSION,
      capturedAt: 1234
    }
    for (const { launchAgent, rowAgent } of [
      { launchAgent: 'claude' as const, rowAgent: null },
      { launchAgent: 'claude' as const, rowAgent: 'claude' },
      { launchAgent: null, rowAgent: 'amp' }
    ]) {
      const tab = project({
        ...rowCase('aged'),
        pty: ptyRecord({ launchAgent }),
        tab: { ...TAB, ...(launchAgent ? { launchAgent } : {}) },
        stored: { facet: codexFacet, rowAgent, rowIsRemnant: false }
      }).tabs[0]
      expect(tab).not.toHaveProperty('conversationIdentity')
      expect(tab).not.toHaveProperty('conversationOfferedWithoutStatus')
    }
  })

  it('publishes the facet of the agent the row names, over a launch record for another agent', () => {
    const codexFacet = { agentType: 'codex', providerSession: CODEX_SESSION, capturedAt: 1234 }
    const tab = project({
      ...rowCase('aged'),
      pty: ptyRecord({ launchAgent: 'claude' }),
      tab: { ...TAB, launchAgent: 'claude' },
      stored: { facet: codexFacet, rowAgent: 'codex', rowIsRemnant: false }
    }).tabs[0]
    expect(tab).toMatchObject({ conversationIdentity: { ...codexFacet, source: 'live' } })
  })

  describe('renderer (desktop-host) path', () => {
    const rendererStatus = (providerSession: typeof CODEX_SESSION, updatedAt: number) => ({
      state: 'done' as const,
      prompt: '',
      updatedAt,
      stateStartedAt: updatedAt,
      stateHistory: [],
      paneKey: PANE_KEY,
      agentType: 'codex',
      providerSession,
      model: 'renderer-model'
    })

    it('keeps the newer renderer path in status and publishes the same address as the field', () => {
      const row = codexRow({
        providerSession: { ...CODEX_SESSION, transcriptPath: '/old.jsonl' },
        model: 'hook-model'
      })
      const status = rendererStatus(
        { ...CODEX_SESSION, transcriptPath: '/new.jsonl' },
        row.receivedAt + 1
      )
      const tab = project({
        rows: [row],
        retained: null,
        tab: { ...TAB, launchAgent: 'codex', agentStatus: status }
      }).tabs[0]
      expect(tab).toMatchObject({
        agentStatus: { providerSession: { transcriptPath: '/new.jsonl' } },
        conversationIdentity: {
          providerSession: { transcriptPath: '/new.jsonl' },
          model: 'renderer-model',
          source: 'renderer'
        }
      })
      expect(tab).not.toHaveProperty('conversationOfferedWithoutStatus')
    })

    it('takes the hook row and its model when the hook address is the one status keeps', () => {
      const row = codexRow({ model: 'hook-model', receivedAt: Date.now() })
      const status = rendererStatus(CODEX_SESSION, row.receivedAt - 1)
      const tab = project({
        rows: [row],
        retained: null,
        tab: { ...TAB, launchAgent: 'codex', agentStatus: status }
      }).tabs[0]
      expect(tab).toMatchObject({
        conversationIdentity: { model: 'hook-model', source: 'legacy-row' }
      })
    })

    it('prefers a stored facet over either status address', () => {
      const facet = { agentType: 'codex', providerSession: CODEX_SESSION, capturedAt: 7 }
      const tab = project({
        rows: [codexRow()],
        retained: null,
        tab: { ...TAB, launchAgent: 'codex', agentStatus: rendererStatus(CODEX_SESSION, 1) },
        stored: { facet, rowAgent: 'codex', rowIsRemnant: false }
      }).tabs[0]
      expect(tab).toMatchObject({ conversationIdentity: { ...facet, source: 'live' } })
    })
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
        const tab = project({
          ...rowCase(kind),
          pty: ptyRecord({ launchAgent: launchAgent ?? null }),
          tab: { ...TAB, ...(launchAgent ? { launchAgent } : {}) }
        }).tabs[0]
        if (expected === null) {
          expect(tab).not.toHaveProperty('conversationIdentity')
          expect(tab).not.toHaveProperty('conversationOfferedWithoutStatus')
          return
        }
        expect(tab).toMatchObject({
          conversationIdentity: { agentType: expected, providerSession: CODEX_SESSION }
        })
      })
    }

    it('names the launch owner when the session came from a compatible wrapped agent', () => {
      const tab = project({
        rows: [codexRow({ agentType: 'pi' })],
        retained: null,
        pty: ptyRecord({ launchAgent: 'omp' }),
        tab: { ...TAB, launchAgent: 'omp' }
      }).tabs[0]
      expect(tab).toMatchObject({
        conversationIdentity: { agentType: 'omp', providerSession: CODEX_SESSION }
      })
    })

    it('rejects a session from another provider than the foreground agent', () => {
      const tab = project({
        ...rowCase('aged'),
        pty: ptyRecord({ launchAgent: null, foregroundAgent: 'claude' }),
        tab: TAB
      }).tabs[0]
      expect(tab).not.toHaveProperty('conversationIdentity')
    })
  })
})
