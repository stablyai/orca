// Runs on plain Node, as orcad does: a paired server stamps its own rows through this same wiring.
import { describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-session-contracts'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { AgentHookServer } from '../../agent-hooks/server'
import { OrcaRuntimeService } from '../orca-runtime'
import type { RuntimeStore } from '../runtime-store-contract'
import {
  hostWorktreeTarget,
  type HostWorktreeTarget
} from '../../../shared/worktree/host-qualified-identity'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const WT = 'repo-1::/tmp/worktree-a'

function createHeadlessRuntime(
  stored: Pick<WorktreeMeta, 'lastActivityAt' | 'smartTier' | 'smartAt'> = { lastActivityAt: 0 }
) {
  const meta: Record<
    string,
    Pick<WorktreeMeta, 'lastActivityAt' | 'smartTier' | 'smartAt'> & { isUnread?: boolean }
  > = {
    [WT]: stored
  }
  const written = new Set<(domains: readonly string[] | undefined) => void>()
  const store = {
    // An unstamped row's writes resolve their host from its repo's only registration.
    getRepos: () => [{ id: 'repo-1', connectionId: null }],
    getRepo: (id: string) => (id === 'repo-1' ? { id, connectionId: null } : undefined),
    getSettings: () => ({}),
    getWorktreeMeta: (id: string) => meta[id],
    getAllWorktreeMeta: () => meta,
    setWorktreeMeta: ({ id }: HostWorktreeTarget, updates: Partial<WorktreeMeta>) => {
      meta[id] = { ...meta[id], ...updates }
      written.forEach((listener) => listener(['worktreeMeta']))
      return meta[id]
    },
    onStateWritten: (listener: (domains: readonly string[] | undefined) => void) => {
      written.add(listener)
      return () => written.delete(listener)
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
  return { runtime, meta, setWorktreeMeta: store.setWorktreeMeta }
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

  it('orders a session boundary’s done as a finish, but raises no unread for it', () => {
    const stampsAfter = (sessionBoundary: boolean) => {
      vi.useFakeTimers({ now: 75_000 })
      try {
        const { runtime, meta } = createHeadlessRuntime()
        const server = new AgentHookServer()
        runtime.attachAgentStatusStore(server)
        const pane = {
          paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
          tabId: 'tab-1',
          worktreeId: WT
        }
        server.ingestTerminalStatus({
          ...pane,
          payload: { state: 'working', prompt: 'task', agentType: 'claude' }
        })
        vi.setSystemTime(76_000)
        server.ingestTerminalStatus({
          ...pane,
          payload: { state: 'done', prompt: 'task', agentType: 'claude', sessionBoundary }
        })
        return meta[WT]
      } finally {
        vi.useRealTimers()
      }
    }
    const { isUnread: boundaryUnread, ...boundary } = stampsAfter(true)
    const { isUnread: finishUnread, ...finish } = stampsAfter(false)
    expect(boundary).toEqual(finish)
    expect(boundary).toMatchObject({ smartTier: 'done', smartAt: 76_000 })
    // No client is looking: a finish is news, a clear or a compaction is not.
    expect(finishUnread).toBe(true)
    expect(boundaryUnread).toBeUndefined()
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

  it('re-tiers a read Done beside a Working pane when any writer clears the flag', () => {
    vi.useFakeTimers({ now: 80_000 })
    try {
      const { runtime, meta, setWorktreeMeta } = createHeadlessRuntime()
      const server = new AgentHookServer()
      runtime.attachAgentStatusStore(server)
      const pane = (id: string, state: 'working' | 'done'): void =>
        server.ingestTerminalStatus({
          paneKey: `tab-1:${id}`,
          tabId: 'tab-1',
          worktreeId: WT,
          payload: { state, prompt: 'task', agentType: 'claude' }
        })
      pane('11111111-1111-4111-8111-111111111111', 'working')
      vi.setSystemTime(90_000)
      pane('22222222-2222-4222-8222-222222222222', 'working')
      vi.setSystemTime(100_000)
      pane('11111111-1111-4111-8111-111111111111', 'done')
      expect(meta[WT]).toMatchObject({ isUnread: true, smartTier: 'done', smartAt: 100_000 })

      // A client opened it (the window's metadata write, a phone, workspace activation).
      setWorktreeMeta(hostWorktreeTarget({ id: WT, hostId: 'local' }), { isUnread: false })
      expect(meta[WT]).toMatchObject({ isUnread: false, smartTier: 'working', smartAt: 90_000 })
    } finally {
      vi.useRealTimers()
    }
  })
})
