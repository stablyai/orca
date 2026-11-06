import { describe, expect, it, vi } from 'vitest'
import type { AgentSwitchRow } from './branch-switch-agent-blocker'
import { createBranchSwitchHost } from './runtime-branch-switch-host'

const CHECKOUT = '/work/app'

type Pty = { ptyId: string; worktreeId: string; connected: true }

function row(key: string, worktreeId: string): AgentSwitchRow {
  return {
    paneKey: `tab-${key}:pane-1`,
    tabId: `tab-${key}`,
    worktreeId,
    connectionId: null,
    state: 'working',
    agentType: 'claude',
    // Expired evidence: the cost is the same whichever rows would block.
    receivedAt: 0
  }
}

/**
 * Unrelated workspaces: N busy agents in worktrees and N in folder workspaces, each with a
 * connected terminal and a saved tab. `candidates` busy agents sit in the switched checkout.
 */
function hostWith(unrelated: number, candidates: number) {
  const rows: AgentSwitchRow[] = []
  const ptys: Pty[] = []
  const tabsByWorktree: Record<string, { id: string }[]> = {}
  const folders = new Map<string, string>()
  for (let index = 0; index < unrelated; index++) {
    for (const workspaceId of [`repo::/work/other-${index}`, `folder:f-${index}`]) {
      const key = `${workspaceId}#${index}`
      rows.push(row(key, workspaceId))
      ptys.push({ ptyId: `pty-${key}`, worktreeId: workspaceId, connected: true })
      tabsByWorktree[workspaceId] = [{ id: `tab-${key}` }]
    }
    folders.set(`f-${index}`, `/work/folder-${index}`)
  }
  for (let index = 0; index < candidates; index++) {
    // Unknown processes: every candidate is judged and none blocks.
    rows.push(row(`app-${index}`, `repo::${CHECKOUT}`))
    ptys.push({ ptyId: `pty-app-${index}`, worktreeId: `repo::${CHECKOUT}`, connected: true })
  }
  const counts = {
    readRows: vi.fn(() => rows),
    readPaneRows: vi.fn((paneKey: string) =>
      rows.filter((candidate) => candidate.paneKey === paneKey)
    ),
    ptys: vi.fn(() => ptys),
    paneOf: vi.fn((pty: Pty) => ({ tabId: `tab-${pty.ptyId.slice(4)}`, paneKey: null })),
    terminalHandlesOf: vi.fn(() => []),
    savedTabIds: vi.fn((workspaceIds: ReadonlySet<string>) =>
      [...workspaceIds].flatMap((id) => (tabsByWorktree[id] ?? []).map((tab) => tab.id))
    ),
    folderWorkspacePaths: vi.fn(() => folders),
    probeProcess: vi.fn(async () => null)
  }
  const host = createBranchSwitchHost<Pty>({
    getStore: () => null,
    readAgentRows: counts.readRows,
    readAgentPaneRows: counts.readPaneRows,
    ptys: counts.ptys,
    paneOf: counts.paneOf,
    terminalHandlesOf: counts.terminalHandlesOf,
    hasSyncedTab: () => false,
    savedTabIds: counts.savedTabIds,
    folderWorkspacePaths: counts.folderWorkspacePaths,
    probeProcess: counts.probeProcess,
    notifyBranchChanged: () => {}
  })
  return { host, counts }
}

async function operations(unrelated: number, candidates: number) {
  const { host, counts } = hostWith(unrelated, candidates)
  await host.getAgentSwitchBlocker(CHECKOUT)
  return {
    readRows: counts.readRows.mock.calls.length,
    paneReads: counts.readPaneRows.mock.calls.length,
    ptyPasses: counts.ptys.mock.calls.length,
    paneOf: counts.paneOf.mock.calls.length,
    handles: counts.terminalHandlesOf.mock.calls.length,
    savedTabReads: counts.savedTabIds.mock.calls.length,
    folderReads: counts.folderWorkspacePaths.mock.calls.length,
    probes: counts.probeProcess.mock.calls.length
  }
}

// Bound, from what the answer needs: each of this checkout's agents must be judged once against
// its current row. The snapshot and the PTY list have no path index, so each is walked once to
// find this checkout's members, and folder directories are read once. Every heavier step (pane
// lookup, handles, saved-tab reads, probes, current-row reads) is per candidate or per in-checkout
// terminal, so it scales with this checkout's agents and never with unrelated workspaces.
describe('branch switch agent check cost', () => {
  it('does no per-terminal, session or probe work for unrelated workspaces', async () => {
    for (const unrelated of [50, 500]) {
      expect(await operations(unrelated, 0)).toEqual({
        readRows: 1,
        paneReads: 0,
        ptyPasses: 0,
        paneOf: 0,
        handles: 0,
        savedTabReads: 0,
        folderReads: 1,
        probes: 0
      })
      for (const candidates of [5, 50]) {
        expect(await operations(unrelated, candidates)).toEqual({
          readRows: 1,
          paneReads: candidates,
          ptyPasses: 1,
          paneOf: candidates,
          handles: candidates,
          savedTabReads: 1,
          folderReads: 1,
          probes: candidates
        })
      }
    }
  })
})
