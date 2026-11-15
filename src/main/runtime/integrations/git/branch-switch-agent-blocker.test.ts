import { describe, expect, it } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import { findAgentSwitchBlocker } from './branch-switch-agent-blocker'

type Row = ReturnType<Parameters<typeof findAgentSwitchBlocker>[0]['readRows']>[number]

const NOW = 10 * AGENT_STATUS_STALE_AFTER_MS
const paths: Record<string, string> = {
  'repo::/work/app': '/work/app',
  'repo::/work/other': '/work/other'
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    paneKey: 'tab-1:pane-1',
    worktreeId: 'repo::/work/app',
    state: 'working',
    agentType: 'claude',
    receivedAt: NOW - 1000,
    connectionId: null,
    ...overrides
  }
}

function blocker(rows: Row[], verdict: 'live' | 'exited' | null = null) {
  return findAgentSwitchBlocker({
    checkoutPath: '/work/app',
    readRows: () => rows,
    readPaneRows: (paneKey) => rows.filter((candidate) => candidate.paneKey === paneKey),
    pathOfWorktree: (id) => paths[id],
    buildTerminalLiveness: () => () => true,
    probeProcess: async () => verdict,
    now: () => NOW
  })
}

describe('findAgentSwitchBlocker', () => {
  it('releases on a verified exit or a finished turn', async () => {
    await expect(blocker([row()], 'exited')).resolves.toBeNull()
    await expect(blocker([row({ state: 'done' })], 'live')).resolves.toBeNull()
  })
})
