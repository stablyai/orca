import { describe, expect, it, vi } from 'vitest'
import type { AgentSwitchRow } from './branch-switch-agent-blocker'
import { createBranchSwitchHost } from './runtime-branch-switch-host'

const CHECKOUT = '/work/app'

type Pty = { ptyId: string; worktreeId: string; connected: true }

function row(index: number, worktreeId: string): AgentSwitchRow {
  return {
    paneKey: `tab-${index}:pane-1`,
    tabId: `tab-${index}`,
    worktreeId,
    connectionId: null,
    state: 'working',
    agentType: 'claude',
    receivedAt: Date.now()
  }
}

/** Unrelated workspaces: N busy agents, N connected terminals and N saved tabs elsewhere. */
function hostWith(unrelated: number, candidateCount: 0 | 1) {
  const rows: AgentSwitchRow[] = []
  const ptys: Pty[] = []
  const tabsByWorktree: Record<string, { id: string }[]> = {}
  for (let index = 0; index < unrelated; index++) {
    const worktreeId = `repo::/work/other-${index}`
    rows.push(row(index, worktreeId))
    ptys.push({ ptyId: `pty-${index}`, worktreeId, connected: true })
    tabsByWorktree[worktreeId] = [{ id: `tab-${index}` }]
  }
  if (candidateCount === 1) {
    rows.push(row(-1, `repo::${CHECKOUT}`))
    ptys.push({ ptyId: 'pty-app', worktreeId: `repo::${CHECKOUT}`, connected: true })
  }
  const counts = {
    readRows: vi.fn(() => rows),
    paneOf: vi.fn((pty: Pty) => ({
      tabId: pty.ptyId === 'pty-app' ? 'tab--1' : null,
      paneKey: null
    })),
    terminalHandlesOf: vi.fn(() => []),
    savedTabIds: vi.fn((workspaceIds: ReadonlySet<string>) =>
      [...workspaceIds].flatMap((id) => (tabsByWorktree[id] ?? []).map((tab) => tab.id))
    ),
    probeProcess: vi.fn(async () => null)
  }
  const host = createBranchSwitchHost<Pty>({
    getStore: () => null,
    readAgentRows: counts.readRows,
    ptys: () => ptys,
    paneOf: counts.paneOf,
    terminalHandlesOf: counts.terminalHandlesOf,
    hasSyncedTab: () => false,
    savedTabIds: counts.savedTabIds,
    probeProcess: counts.probeProcess,
    notifyBranchChanged: () => {}
  })
  return { host, counts }
}

async function operations(unrelated: number, candidateCount: 0 | 1) {
  const { host, counts } = hostWith(unrelated, candidateCount)
  await host.getAgentSwitchBlocker(CHECKOUT)
  return {
    readRows: counts.readRows.mock.calls.length,
    paneOf: counts.paneOf.mock.calls.length,
    handles: counts.terminalHandlesOf.mock.calls.length,
    savedTabReads: counts.savedTabIds.mock.calls.length,
    probes: counts.probeProcess.mock.calls.length
  }
}

// Bound: the snapshot and PTY list are flat, so one string-only pass each finds this checkout's
// members; every heavier step (pane lookup, handles, session reads, probes) is per checkout member
// and per session host, so unrelated workspaces must add none of it.
describe('branch switch agent check cost', () => {
  it('does no terminal, session or probe work for unrelated workspaces', async () => {
    for (const unrelated of [50, 500]) {
      expect(await operations(unrelated, 0)).toEqual({
        readRows: 1,
        paneOf: 0,
        handles: 0,
        savedTabReads: 0,
        probes: 0
      })
      expect(await operations(unrelated, 1)).toEqual({
        readRows: 2,
        paneOf: 1,
        handles: 1,
        savedTabReads: 1,
        probes: 1
      })
    }
  })
})
