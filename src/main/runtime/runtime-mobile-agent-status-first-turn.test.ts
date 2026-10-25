import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { RuntimeMobileSessionTerminalTab } from '../../shared/runtime-types'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { buildRuntimeMobileAgentStatus } from './runtime-mobile-agent-status-builder'

const NOW = 1_800_000_000_000
const PROVIDER_SESSION = { key: 'session_id' as const, id: 'first-turn-session' }
const TAB: RuntimeMobileSessionTerminalTab = {
  type: 'terminal',
  id: 'tab::leaf',
  parentTabId: 'tab',
  leafId: 'leaf',
  title: 'Terminal',
  launchAgent: 'codex',
  isActive: true
}

/** Keep sequence ordering separate from wall time to expose mismatched title-clock selection. */
function shellPty(): RuntimePtyWorktreeRecord {
  const titleAt = NOW - 1_000
  return {
    ptyId: 'pty-1',
    incarnationId: null,
    worktreeId: 'wt-1',
    connectionId: null,
    runtimeSessionOwned: true,
    isWsl: false,
    wslDistro: null,
    tabId: 'tab',
    paneKey: 'tab:leaf',
    surfaceRecordedAtGraphSequence: 0,
    launchConfig: null,
    launchToken: null,
    launchIncarnationId: null,
    launchAgent: 'codex',
    launchCommandAgent: null,
    agentSessionOwners: [],
    foregroundAgent: 'codex',
    connected: true,
    disconnectedAt: null,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: 'idle',
    lastAgentStatusObservedLive: true,
    lastAgentStatusStartedAtEpochMs: titleAt,
    lastAgentStatusRichInvalidatedAtEpochMs: titleAt,
    lastOscTitle: 'zsh',
    lastOscTitleAt: 1,
    lastOscTitleEpochMs: titleAt,
    managementTitle: null,
    managementTitleAt: null,
    controllerTitle: null,
    title: 'zsh',
    titleUpdatedAt: 1,
    titleObservedAtEpochMs: titleAt,
    lastOutputAt: NOW,
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

function hookRow(): AgentStatusIpcPayload {
  return {
    paneKey: 'tab:leaf',
    state: 'working',
    prompt: '',
    agentType: 'codex',
    connectionId: null,
    receivedAt: NOW,
    evidenceObservedAt: NOW,
    stateStartedAt: NOW,
    providerSession: PROVIDER_SESSION
  }
}

/** Exercise the host projection without renderer-retained status masking first-turn identity. */
function projectedSession(
  pty: Partial<RuntimePtyWorktreeRecord>,
  row: Partial<AgentStatusIpcPayload> = {}
) {
  const record = { ...shellPty(), ...pty }
  return buildRuntimeMobileAgentStatus(
    record,
    TAB,
    'term-1',
    null,
    () => [{ ...hookRow(), ...row }],
    {
      getPaneKey: () => 'tab:leaf',
      getLeaf: () => null,
      getTrackedTitle: () => null
    }
  ).agentStatus?.providerSession
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => vi.useRealTimers())

describe('first-turn mobile chat identity under the pre-launch shell title', () => {
  it.each([
    ['an older shell title', {}, {}],
    [
      'an older selected recorded title, despite a later OSC clock',
      { lastOscTitleEpochMs: NOW + 1_000, titleUpdatedAt: 2, titleObservedAtEpochMs: NOW - 1_000 },
      {}
    ]
  ])('addresses a fresh hook after %s', (_name, pty, row) => {
    expect(projectedSession(pty, row)).toEqual(PROVIDER_SESSION)
  })

  it.each([
    ['a shell title from the same ms', { lastOscTitleAt: 2, lastOscTitleEpochMs: NOW }, {}],
    ['a newer shell title', { lastOscTitleAt: 2, lastOscTitleEpochMs: NOW + 1_000 }, {}],
    [
      'a newer selected recorded title',
      { titleUpdatedAt: 2, titleObservedAtEpochMs: NOW + 1_000 },
      {}
    ],
    [
      'a selected recorded title with no clock',
      { titleUpdatedAt: 2, titleObservedAtEpochMs: null },
      {}
    ],
    ['replayed evidence older than the title', {}, { evidenceObservedAt: NOW - 2_000 }],
    ['a restored hook', {}, { restoredUnconfirmed: true }]
  ])('suppresses the hook under %s', (_name, pty, row) => {
    expect(projectedSession(pty, row)).toBeUndefined()
  })

  it('does not invent a transcript for an empty pane', () => {
    const status = buildRuntimeMobileAgentStatus(shellPty(), TAB, 'term-1', null, () => [], {
      getPaneKey: () => 'tab:leaf',
      getLeaf: () => null,
      getTrackedTitle: () => null
    })
    expect(status).not.toHaveProperty('agentStatus')
  })
})
