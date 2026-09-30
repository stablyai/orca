import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTerminalTab } from '../../shared/runtime-types'
import type { RuntimeAgentRowSnapshot } from './runtime-hook-agent-row-selection'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { buildRuntimeMobileAgentStatus } from './runtime-mobile-agent-status-builder'

const PROVIDER_SESSION = { key: 'session_id' as const, id: 'session-1' }
const TAB: RuntimeMobileSessionTerminalTab = {
  type: 'terminal',
  id: 'tab::leaf',
  parentTabId: 'tab',
  leafId: 'leaf',
  title: 'Terminal',
  isActive: true
}

function codexPty(foregroundAgent: RuntimePtyWorktreeRecord['foregroundAgent']) {
  return {
    ptyId: 'pty-1',
    incarnationId: null,
    worktreeId: 'worktree-1',
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
    foregroundAgent,
    connected: true,
    disconnectedAt: null,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: 'idle',
    lastAgentStatusObservedLive: true,
    lastAgentStatusStartedAtEpochMs: 100,
    lastAgentStatusRichInvalidatedAtEpochMs: null,
    lastOscTitle: 'Test hello 123 | fc-analytics-service',
    lastOscTitleAt: 100,
    lastOscTitleEpochMs: 100,
    managementTitle: null,
    managementTitleAt: null,
    controllerTitle: null,
    title: 'Test hello 123 | fc-analytics-service',
    titleUpdatedAt: 100,
    lastOutputAt: 100,
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
  } satisfies RuntimePtyWorktreeRecord
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

  it('keeps Codex chat addressable under a neutral conversation title while Codex is foregrounded', () => {
    const hook = {
      paneKey: 'tab:leaf',
      connectionId: null,
      state: 'done',
      prompt: '',
      agentType: 'codex',
      receivedAt: Date.now(),
      stateStartedAt: Date.now(),
      providerSession: PROVIDER_SESSION
    } as const
    const host = {
      getPaneKey: () => 'tab:leaf',
      getLeaf: () => null,
      getTrackedTitle: () => null
    }

    const live = buildRuntimeMobileAgentStatus(
      codexPty('codex'),
      TAB,
      'term-1',
      null,
      () => [hook],
      host
    )
    expect(live).toEqual({
      agentStatus: expect.objectContaining({
        agentType: 'codex',
        providerSession: PROVIDER_SESSION,
        state: 'done'
      })
    })

    const shell = buildRuntimeMobileAgentStatus(
      codexPty(null),
      TAB,
      'term-1',
      null,
      () => [hook],
      host
    )
    expect(shell).toEqual({})
  })
})
