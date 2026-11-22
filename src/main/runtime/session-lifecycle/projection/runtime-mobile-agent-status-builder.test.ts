import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_STATUS_HELD_ROW_MAX_AGE_MS } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { RuntimeMobileSessionTerminalTab } from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { RuntimePtyWorktreeRecord } from '../../terminal/records/runtime-terminal-state-records'
import { buildRuntimeMobileAgentStatus } from './runtime-mobile-agent-status-builder'

const NOW = 1_800_000_000_000
const STALE_BY = 31 * 60 * 1000
const PANE_KEY = 'tab-1:leaf-1'

const tab = {
  type: 'terminal',
  id: 'tab-1',
  title: 'Pi',
  parentTabId: 'tab-1',
  leafId: 'leaf-1',
  isActive: true
} satisfies RuntimeMobileSessionTerminalTab

const host = {
  getPaneKey: () => PANE_KEY,
  getLeaf: () => null,
  getTrackedTitle: () => null
}

/** Only the fields this builder reads matter here; the record itself is owned by the runtime. */
function pty(overrides: Partial<RuntimePtyWorktreeRecord> = {}): RuntimePtyWorktreeRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the builder reads only these fields; the rest belongs to the live runtime record.
  return {
    ptyId: 'pty-1',
    worktreeId: 'worktree-1',
    foregroundAgent: 'pi',
    connected: true,
    lastAgentStatus: 'idle',
    lastAgentStatusStartedAtEpochMs: NOW - STALE_BY,
    lastAgentStatusRichInvalidatedAtEpochMs: null,
    lastOscTitle: null,
    lastOscTitleAt: null,
    lastOscTitleEpochMs: null,
    title: null,
    titleUpdatedAt: null,
    ...overrides
  } as unknown as RuntimePtyWorktreeRecord
}

function hookRow(overrides: Partial<AgentStatusIpcPayload>): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    connectionId: null,
    state: 'working',
    prompt: '',
    receivedAt: NOW - STALE_BY,
    stateStartedAt: NOW - STALE_BY - 60_000,
    agentType: 'pi',
    ...overrides
  }
}

function statusOf(result: { agentStatus: AgentStatusEntry } | Record<string, never>) {
  return 'agentStatus' in result ? result.agentStatus : null
}

function build(rows: AgentStatusIpcPayload[], record = pty()) {
  return statusOf(
    buildRuntimeMobileAgentStatus(record, tab, null, null, () => rows, host)
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('buildRuntimeMobileAgentStatus stale working rows (#46585)', () => {
  it('keeps a stale working lead unverifiable and keeps its live children instead of synthesizing done', () => {
    const status = build([
      hookRow({
        subagents: [{ id: 'child-live', state: 'working', startedAt: NOW - 40 * 60 * 1000 }]
      })
    ])

    // Before the fix the 30-minute freshness cap dropped the row to a title-only done with no children.
    expect(status).toMatchObject({
      state: 'working',
      restoredUnconfirmed: true,
      subagents: [{ id: 'child-live', state: 'working', startedAt: NOW - 40 * 60 * 1000 }]
    })
  })

  it('still converges to done once the children settle (regression red line)', () => {
    const status = build([
      hookRow({ subagents: [{ id: 'child-done', state: 'idle', startedAt: NOW - 40 * 60 * 1000 }] })
    ])

    expect(status).toMatchObject({ state: 'done' })
    expect(status?.restoredUnconfirmed).toBeUndefined()
  })

  it('leaves a non-working lead terminal path unchanged (regression red line)', () => {
    const status = build([
      hookRow({
        state: 'done',
        subagents: [{ id: 'child-live', state: 'working', startedAt: NOW - 40 * 60 * 1000 }]
      })
    ])

    expect(status).toMatchObject({ state: 'done' })
    expect(status?.restoredUnconfirmed).toBeUndefined()
  })

  it('releases the hold after the longer bounded window, falling back to title-only done (#46585 review)', () => {
    const overMaxAgeBy = AGENT_STATUS_HELD_ROW_MAX_AGE_MS + 60_000
    const status = build(
      [
        hookRow({
          receivedAt: NOW - overMaxAgeBy,
          stateStartedAt: NOW - overMaxAgeBy - 60_000,
          subagents: [{ id: 'child-live', state: 'working', startedAt: NOW - overMaxAgeBy }]
        })
      ],
      pty({ lastAgentStatusStartedAtEpochMs: NOW - overMaxAgeBy })
    )

    expect(status).toMatchObject({ state: 'done' })
    expect(status?.restoredUnconfirmed).toBeUndefined()
  })

  it('releases the hold when the provider generation resets in the same PTY (#46585 review)', () => {
    const status = build(
      [
        hookRow({
          subagents: [{ id: 'child-live', state: 'working', startedAt: NOW - 40 * 60 * 1000 }]
        })
      ],
      // Pi quit and relaunched in the same PTY: the new agent generation postdates the stale row.
      pty({ providerGenerationResetAtEpochMs: NOW - 10 * 60 * 1000 })
    )

    expect(status).toMatchObject({ state: 'done' })
    expect(status?.restoredUnconfirmed).toBeUndefined()
  })

  it('keeps holding when the generation reset predates the stale row', () => {
    const status = build(
      [
        hookRow({
          subagents: [{ id: 'child-live', state: 'working', startedAt: NOW - 40 * 60 * 1000 }]
        })
      ],
      pty({ providerGenerationResetAtEpochMs: NOW - 2 * 60 * 60 * 1000 })
    )

    expect(status).toMatchObject({
      state: 'working',
      restoredUnconfirmed: true,
      subagents: [{ id: 'child-live', state: 'working', startedAt: NOW - 40 * 60 * 1000 }]
    })
  })
})
