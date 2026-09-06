/**
 * A slept pane must read as asleep-but-resumable, not as absent.
 *
 * `connected` keeps its execution-host meaning throughout — the process really
 * did exit — so the new fact rides on a separate `resumable` marker.
 */
import { describe, expect, it } from 'vitest'
import type { RuntimeTerminalSummary } from '../../shared/runtime-types'
import type { ResumableSleptPane } from './resumable-slept-pane-listing'
import { RuntimeTerminalList } from './runtime-terminal-list'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

const WORKTREE: ResolvedWorktree = {
  id: 'wt-1',
  path: '/tmp/wt-1',
  branch: 'main'
} as unknown as ResolvedWorktree

const SLEPT_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const LIVE_LEAF_ID = '22222222-2222-4222-8222-222222222222'

const SLEPT_PANE: ResumableSleptPane = {
  paneKey: `tab-slept:${SLEPT_LEAF_ID}`,
  worktreeId: 'wt-1',
  tabId: 'tab-slept',
  leafId: SLEPT_LEAF_ID,
  title: 'coordinator',
  agent: 'claude',
  lastOutputAt: 42
}

function leaf(overrides: Partial<RuntimeLeafRecord> = {}): RuntimeLeafRecord {
  return {
    tabId: 'tab-live',
    leafId: LIVE_LEAF_ID,
    worktreeId: 'wt-1',
    ptyId: 'pty-live',
    connected: true,
    ...overrides
  } as unknown as RuntimeLeafRecord
}

function pty(overrides: Partial<RuntimePtyWorktreeRecord> = {}): RuntimePtyWorktreeRecord {
  return {
    ptyId: 'pty-live',
    worktreeId: 'wt-1',
    connected: true,
    paneKey: `tab-live:${LIVE_LEAF_ID}`,
    ...overrides
  } as unknown as RuntimePtyWorktreeRecord
}

function summaryFor(source: { tabId: string; leafId: string }): RuntimeTerminalSummary {
  return {
    handle: `term_${source.tabId}`,
    ptyId: null,
    worktreeId: 'wt-1',
    worktreePath: '/tmp/wt-1',
    branch: 'main',
    tabId: source.tabId,
    leafId: source.leafId,
    title: null,
    connected: false,
    writable: false,
    lastOutputAt: null,
    preview: ''
  }
}

function makeList(args: {
  leaves?: RuntimeLeafRecord[]
  ptys?: RuntimePtyWorktreeRecord[]
  sleptPanes?: ResumableSleptPane[]
  worktree?: ResolvedWorktree
}) {
  const sleptPaneCalls: (string | null)[] = []
  const list = new RuntimeTerminalList({
    getGraphEpoch: () => 1,
    assertGraphEpoch: () => undefined,
    getExplicitWorktreeId: () => 'wt-1',
    getResolvedCache: () => null,
    buildWorktreeFromId: () => WORKTREE,
    resolveWorktree: () => Promise.resolve(WORKTREE),
    listKnownWorktrees: () => [WORKTREE],
    getWorktreeMap: () => {
      const worktree = args.worktree ?? WORKTREE
      return Promise.resolve(new Map([[worktree.id, worktree]]))
    },
    refreshPtys: () =>
      Promise.resolve({ livePtyIds: ['pty-live'], allLivePtyIds: new Set(['pty-live']) } as never),
    getPtys: () => args.ptys ?? [],
    getLeaves: () => args.leaves ?? [],
    buildLeafSummary: (source) => ({
      ...summaryFor(source),
      ptyId: source.ptyId,
      connected: source.ptyId !== null
    }),
    buildPtySummary: (source) => summaryFor({ tabId: source.tabId ?? 'pty', leafId: 'pty' }),
    listResumableSleptPanes: (targetWorktreeId) => {
      sleptPaneCalls.push(targetWorktreeId)
      return args.sleptPanes ?? []
    },
    buildSleptPaneSummary: (pane, _worktrees, resolvedWorktree) => ({
      ...summaryFor(pane),
      handle: `term_${pane.paneKey}`,
      worktreePath: resolvedWorktree?.path ?? '',
      branch: resolvedWorktree?.branch ?? '',
      title: pane.title,
      resumable: true,
      agentIdentity: pane.agent
    }),
    getSnapshots: () => new Map(),
    getTabTitle: () => null,
    getTopologyRevision: () => 1,
    buildHostScope: () => ({ hostIds: [], omittedHostIds: [] })
  })
  return { list, sleptPaneCalls }
}

describe('terminal list with slept panes', () => {
  it('lists a slept pane whose tab left the renderer graph', async () => {
    const { list } = makeList({ leaves: [leaf()], ptys: [pty()], sleptPanes: [SLEPT_PANE] })
    const result = await list.list('wt-1', 10, { includeVisualLayouts: false })
    const slept = result.terminals.find((terminal) => terminal.tabId === 'tab-slept')
    expect(slept).toMatchObject({
      connected: false,
      resumable: true,
      title: 'coordinator',
      agentIdentity: 'claude'
    })
    expect(result.totalCount).toBe(2)
  })

  it('keeps a PTY-less leaf visible when a resume record claims it', async () => {
    const sleptLeaf = leaf({ tabId: 'tab-slept', leafId: SLEPT_LEAF_ID, ptyId: null })
    const { list } = makeList({
      leaves: [leaf(), sleptLeaf],
      ptys: [pty()],
      sleptPanes: [SLEPT_PANE]
    })
    const result = await list.list('wt-1', 10, { includeVisualLayouts: false })
    const rows = result.terminals.filter((terminal) => terminal.tabId === 'tab-slept')
    expect(rows).toHaveLength(1)
    // The leaf row, not the synthesized one: it carries the pane's real title,
    // preview and last-output time that persistence alone cannot supply.
    expect(rows[0]).toMatchObject({
      handle: 'term_tab-slept',
      connected: false,
      resumable: true
    })
  })

  it('still drops a PTY-less leaf that has no resume record', async () => {
    const orphanLeaf = leaf({ tabId: 'tab-pending', leafId: 'leaf-pending', ptyId: null })
    const { list } = makeList({ leaves: [leaf(), orphanLeaf], ptys: [pty()] })
    const result = await list.list('wt-1', 10, { includeVisualLayouts: false })
    expect(result.terminals.map((terminal) => terminal.tabId)).toEqual(['tab-live'])
  })

  it('never offers a slept pane to a liveness-required listing', async () => {
    const { list, sleptPaneCalls } = makeList({ ptys: [pty()], sleptPanes: [SLEPT_PANE] })
    const result = await list.list('wt-1', 10, {
      requireFreshPtyLiveness: true,
      includeVisualLayouts: false
    })
    expect(sleptPaneCalls).toEqual([])
    expect(result.terminals.some((terminal) => terminal.resumable)).toBe(false)
  })

  it('does not duplicate a pane that a live PTY row already covers', async () => {
    const stalePane = {
      ...SLEPT_PANE,
      paneKey: `tab-live:${LIVE_LEAF_ID}`,
      leafId: LIVE_LEAF_ID
    }
    const { list } = makeList({ ptys: [pty()], sleptPanes: [stalePane] })
    const result = await list.list('wt-1', 10, { includeVisualLayouts: false })
    expect(result.terminals).toHaveLength(1)
    expect(result.terminals[0].resumable).toBeUndefined()
  })

  it('does not duplicate a slept leaf after its tab id is reminted', async () => {
    const remintedLeaf = leaf({ tabId: 'tab-reminted', leafId: SLEPT_LEAF_ID, ptyId: null })
    const { list } = makeList({
      leaves: [leaf(), remintedLeaf],
      ptys: [pty()],
      sleptPanes: [SLEPT_PANE]
    })
    const result = await list.list('wt-1', 10, { includeVisualLayouts: false })
    expect(result.terminals.filter((terminal) => terminal.leafId === SLEPT_LEAF_ID)).toHaveLength(1)
  })

  it('resolves slept-pane metadata through equivalent worktree identity', async () => {
    const resolved = {
      ...WORKTREE,
      id: 'repo-1::/tmp/wt-1',
      path: '/tmp/wt-1',
      branch: 'feature'
    } as ResolvedWorktree
    const pane = { ...SLEPT_PANE, worktreeId: 'repo-1::/tmp//wt-1/' }
    const { list } = makeList({ sleptPanes: [pane], worktree: resolved })

    const result = await list.list(undefined, 10, { includeVisualLayouts: false })

    expect(result.terminals[0]).toMatchObject({ worktreePath: '/tmp/wt-1', branch: 'feature' })
  })
})
