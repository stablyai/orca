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

function shellPty(titleAt: number): RuntimePtyWorktreeRecord {
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

function hookRow(state: 'working' | 'done' = 'done'): AgentStatusIpcPayload {
  return {
    paneKey: 'tab:leaf',
    state,
    prompt: '',
    agentType: 'codex',
    connectionId: null,
    receivedAt: NOW,
    evidenceObservedAt: NOW,
    stateStartedAt: NOW,
    providerSession: PROVIDER_SESSION
  }
}

function project(titleAt: number, rows: AgentStatusIpcPayload[]) {
  return buildRuntimeMobileAgentStatus(shellPty(titleAt), TAB, 'term-1', null, () => rows, {
    getPaneKey: () => 'tab:leaf',
    getLeaf: () => null,
    getTrackedTitle: () => null
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => vi.useRealTimers())

describe('first-turn mobile chat identity under the pre-launch shell title', () => {
  it.each(['working', 'done'] as const)(
    'addresses the transcript after a fresh %s hook without tool or question metadata',
    (state) => {
      const result = project(NOW - 1_000, [hookRow(state)])

      expect(result.agentStatus).toMatchObject({
        state: 'done',
        agentType: 'codex',
        providerSession: PROVIDER_SESSION
      })
    }
  )

  it.each([0, 1_000])('still suppresses a hook when the shell title is %i ms newer', (delta) => {
    expect(project(NOW + delta, [hookRow()])).not.toHaveProperty('agentStatus')
  })

  it('does not let replay delivery time revive evidence older than the shell title', () => {
    const replayed = { ...hookRow(), evidenceObservedAt: NOW - 2_000 }

    expect(project(NOW - 1_000, [replayed])).not.toHaveProperty('agentStatus')
  })

  it('does not treat a restored hook as current first-turn evidence', () => {
    const restored = { ...hookRow(), restoredUnconfirmed: true }

    expect(project(NOW - 1_000, [restored])).not.toHaveProperty('agentStatus')
  })

  it('does not invent a transcript for an empty pane', () => {
    expect(project(NOW - 1_000, [])).not.toHaveProperty('agentStatus')
  })
})
