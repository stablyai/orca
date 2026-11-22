import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { resolveAgentRowState } from '../../../../shared/agent-status/presentation/agent-row-decay-state'
import type { RuntimeMobileSessionTerminalTab } from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { RuntimePtyWorktreeRecord } from '../../terminal/records/runtime-terminal-state-records'
import { buildRuntimeMobileAgentStatus } from './runtime-mobile-agent-status-builder'
import { renewRuntimeMobileAgentStatusFromPtyTitle } from './runtime-mobile-agent-status-projection'

const observedAt = 10000
const now = observedAt + 31 * 60 * 1000
const titleAt = observedAt + 1000
const child = { id: 'test-child', state: 'working' as const, startedAt: observedAt }
const row: AgentStatusIpcPayload = {
  state: 'working',
  agentType: 'pi',
  subagents: [child],
  paneKey: 'test-pane',
  prompt: '',
  connectionId: null,
  receivedAt: observedAt,
  stateStartedAt: observedAt
}
const tab: RuntimeMobileSessionTerminalTab = {
  type: 'terminal',
  id: 'test-leaf',
  leafId: 'test-leaf',
  parentTabId: 'test-tab',
  launchAgent: 'pi',
  title: 'Pi',
  isActive: true
}
const pty: RuntimePtyWorktreeRecord = {
  connected: true,
  worktreeId: 'test-worktree',
  ptyId: 'test-pty',
  incarnationId: null,
  connectionId: null,
  runtimeSessionOwned: true,
  isWsl: null,
  wslDistro: null,
  launchConfig: null,
  launchToken: null,
  launchIncarnationId: null,
  launchAgent: 'pi',
  launchCommandAgent: null,
  agentSessionOwners: [],
  foregroundAgent: null,
  disconnectedAt: null,
  lastExitCode: null,
  lastExitCause: null,
  lastAgentStatus: 'idle',
  lastAgentStatusObservedLive: true,
  lastAgentStatusStartedAtEpochMs: titleAt,
  lastAgentStatusRichInvalidatedAtEpochMs: titleAt,
  lastOscTitle: 'Pi',
  lastOscTitleAt: titleAt,
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

function refresh(rows = [row], process = pty) {
  return buildRuntimeMobileAgentStatus(process, tab, null, null, () => rows, {
    getPaneKey: () => row.paneKey,
    getLeaf: () => null,
    getTrackedTitle: () => null
  }).agentStatus
}

describe('Pi status on paired worktree refresh', () => {
  afterEach(() => vi.restoreAllMocks())

  it('keeps the old child roster without treating it as a fresh signal', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const status = refresh()
    expect(status).toMatchObject({ state: 'working', updatedAt: observedAt, subagents: [child] })
    expect(status && resolveAgentRowState(status, now, true)).toBe('unverifiable')
    expect(status && renewRuntimeMobileAgentStatusFromPtyTitle(status, pty)).toEqual(status)
  })

  it('retires child evidence on provider reset or a newer confirmed completion', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    expect(refresh([row], { ...pty, providerGenerationResetAtEpochMs: titleAt })?.state).toBe(
      'done'
    )
    expect(
      refresh([row, { ...row, state: 'done', subagents: undefined, receivedAt: titleAt }])?.state
    ).toBe('done')
  })
})
