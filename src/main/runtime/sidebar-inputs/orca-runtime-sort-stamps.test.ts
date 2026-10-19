// Runs on plain Node, as orcad does: a paired server stamps its own rows through this same wiring.
import { describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-session-contracts'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { AgentHookServer } from '../../agent-hooks/server'
import { OrcaRuntimeService } from '../orca-runtime'
import type { RuntimeStore } from '../runtime-store-contract'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const WT = 'repo-1::/tmp/worktree-a'

function createHeadlessRuntime(
  stored: Pick<WorktreeMeta, 'lastActivityAt' | 'smartTier' | 'smartAt'> = { lastActivityAt: 0 }
) {
  const meta: Record<string, Pick<WorktreeMeta, 'lastActivityAt' | 'smartTier' | 'smartAt'>> = {
    [WT]: stored
  }
  const store = {
    getRepos: () => [],
    getRepo: (id: string) => (id === 'repo-1' ? { id, connectionId: null } : undefined),
    getSettings: () => ({}),
    getWorktreeMeta: (id: string) => meta[id],
    getAllWorktreeMeta: () => meta,
    setWorktreeMeta: (id: string, updates: Partial<WorktreeMeta>) => {
      meta[id] = { ...meta[id], ...updates }
      return meta[id]
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stamp path reads only these members.
  const runtime = new OrcaRuntimeService(store as unknown as RuntimeStore)
  // No window: a server with no client attached must still see its own bells and titles.
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, {
    tabs: [
      { tabId: 'tab-1', worktreeId: WT, title: 'Terminal', activeLeafId: 'pane:1', layout: null }
    ],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: WT,
        leafId: 'pane:1',
        paneRuntimeId: 1,
        ptyId: 'pty-1',
        paneTitle: null
      }
    ]
  })
  return { runtime, meta }
}

describe('host sort stamps on a headless runtime', () => {
  it('stamps a bell the host scans from its own bytes', () => {
    vi.useFakeTimers({ now: 50_000 })
    try {
      const { runtime, meta } = createHeadlessRuntime()
      runtime.onPtyData('pty-1', '\x07', 1)
      expect(meta[WT].lastActivityAt).toBe(50_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('announces a burst of stamp writes once, as a metadata change of the row’s repo', () => {
    vi.useFakeTimers({ now: 55_000 })
    try {
      const { runtime, meta } = createHeadlessRuntime()
      const events: { type: string }[] = []
      runtime.onClientEvent((event) => events.push(event), { consumesTerminalSideEffects: false })
      runtime.onPtyData('pty-1', '\x1b]0;⠂ Working\x07', 1)
      runtime.onPtyData('pty-1', '\x1b]0;bash\x07', 2)
      runtime.onPtyData('pty-1', '\x1b]0;⠂ Working\x07', 3)
      expect(meta[WT].smartTier).toBe('working')
      expect(events.filter((event) => event.type === 'worktreesChanged')).toEqual([])
      vi.advanceTimersByTime(50)
      expect(events.filter((event) => event.type === 'worktreesChanged')).toEqual([
        expect.objectContaining({ type: 'worktreesChanged', repoId: 'repo-1' })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('stamps a bell the daemon reports for a parked terminal', () => {
    vi.useFakeTimers({ now: 60_000 })
    try {
      const { runtime, meta } = createHeadlessRuntime()
      runtime.emitDaemonPtyTransientFact('pty-1', { kind: 'bell' })
      expect(meta[WT].lastActivityAt).toBe(60_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stamps agent transitions from the attached hook store', () => {
    vi.useFakeTimers({ now: 70_000 })
    try {
      const { runtime, meta } = createHeadlessRuntime()
      const server = new AgentHookServer()
      runtime.attachAgentStatusStore(server)
      server.ingestTerminalStatus({
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        tabId: 'tab-1',
        worktreeId: WT,
        payload: { state: 'waiting', prompt: 'task', agentType: 'claude' }
      })
      // No client is looking, so the request for input also raises the unread flag.
      expect(meta[WT]).toEqual({
        lastActivityAt: 70_000,
        smartTier: 'needs-you',
        smartAt: 70_000,
        isUnread: true
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconciles stored tiers once the provider can answer for the workspace’s terminals', async () => {
    const live = createHeadlessRuntime({ lastActivityAt: 5, smartTier: 'done', smartAt: 4 })
    live.runtime.attachAgentStatusStore(new AgentHookServer())
    await live.runtime.sidebarFacts?.reconcileSortStampTiers({ probePtyLiveness: async () => true })
    expect(live.meta[WT]).toEqual({ lastActivityAt: 5, smartTier: 'done', smartAt: 4 })

    const gone = createHeadlessRuntime({ lastActivityAt: 5, smartTier: 'done', smartAt: 4 })
    gone.runtime.attachAgentStatusStore(new AgentHookServer())
    await gone.runtime.sidebarFacts?.reconcileSortStampTiers({
      probePtyLiveness: async () => false
    })
    expect(gone.meta[WT]).toEqual({ lastActivityAt: 5, smartTier: undefined, smartAt: undefined })
  })
})
