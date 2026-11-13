import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import type { AgentStatusStoreView } from '../workspace-facts/workspace-activity-facts-producer'

import '../../../../shared/agent-status/contracts/agent-status-subject'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import type { TerminalSideEffectFact } from '../../../../shared/terminal/output/terminal-side-effect-facts'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import '../../../../shared/sidebar-list/sorting/sort-stamps'
import type { SmartStampFields } from '../../../../shared/sidebar-list/sorting/sort-stamps'
import '../../../../shared/agent-status/lifecycle/agent-transitions.test-fixture'
import type { AgentTransitionStep } from '../../../../shared/agent-status/lifecycle/agent-transitions.test-fixture'
import { AgentTransitionDetector } from '../../../agent-hooks/observations/agent-transition-detector'
import '../../../../shared/sidebar-list/sorting/stamp-order'
import { SortStampsProducer, type StoredTierEvidence } from './sort-stamps-producer'
import type { SortStampsStore } from '../../workspaces/metadata/workspace-activity-records'

vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

const WT = 'repo-1::/tmp/a'
const FOLDER_ID = '11111111-1111-4111-8111-111111111111'
const FOLDER = `folder:${FOLDER_ID}`
const PANE = 'tab-a:22222222-2222-4222-8222-222222222222'
const TITLE_PANE = 'tab-t:33333333-3333-4333-8333-333333333333'
const T0 = 1_000_000

type Stamps = { lastActivityAt: number; isUnread?: boolean } & SmartStampFields
const SSH_HOST = 'ssh:build-box'
const LOCAL_REPO: Repo = {
  id: 'repo-1',
  path: '/tmp',
  displayName: 'repo-1',
  badgeColor: '#000',
  addedAt: 0
}

function createHarness() {
  const meta = new Map<string, Stamps & { hostId?: ExecutionHostId }>([[WT, { lastActivityAt: 0 }]])
  const sshMeta = new Map<string, Stamps>([[WT, { lastActivityAt: 0 }]])
  const folders = new Map<string, Stamps & { connectionId?: string }>([
    [FOLDER_ID, { lastActivityAt: 0 }]
  ])
  const exits = new Map<string, () => void>()
  const fenced = new Set<string>()
  const notified: string[] = []
  let listener: (event: RuntimeClientEvent) => void = () => {}
  // Stamping tests watch every workspace, so no unread flag is raised; the unread tests unwatch.
  const viewing = { isViewing: (_id: string, _pane: string | null): boolean => true }
  const store: SortStampsStore = {
    getWorktreeMeta: (id) => meta.get(id),
    setWorktreeMeta: ({ id, hostId }, updates) => {
      if (hostId === SSH_HOST) {
        sshMeta.set(id, { lastActivityAt: 0, ...sshMeta.get(id), ...updates })
        return
      }
      meta.set(id, { lastActivityAt: 0, ...meta.get(id), ...updates })
    },
    getRepos: () => [LOCAL_REPO],
    getWorktreeMetaForHost: (id, hostId) => (hostId === SSH_HOST ? sshMeta.get(id) : undefined),
    getFolderWorkspace: (id) => folders.get(id),
    updateFolderWorkspace: (id, updates) => {
      folders.set(id, { lastActivityAt: 0, ...folders.get(id), ...updates })
    },
    getAllWorktreeMeta: () => Object.fromEntries(meta),
    getFolderWorkspaces: () => [...folders].map(([id, folder]) => ({ id, ...folder }))
  }
  const detector = new AgentTransitionDetector({
    resolveTabWorktreeId: (tabId) => (tabId === 'tab-t' ? WT : undefined),
    subscribeToPtyExit: (ptyId, onExit) => {
      exits.set(ptyId, onExit)
      return () => exits.delete(ptyId)
    },
    now: () => Date.now()
  })
  const producer = new SortStampsProducer({
    store: () => store,
    isWriteFenced: (id) => fenced.has(id),
    onClientEvent: (next) => {
      listener = next
      return () => {}
    },
    isViewing: (id, pane) => viewing.isViewing(id, pane),
    onStampsWritten: (id) => notified.push(id),
    now: () => Date.now()
  })
  producer.attachAgentTransitions(detector)
  const server = new AgentHookServer()
  return {
    producer,
    detector,
    attach: (view: AgentStatusStoreView) => detector.attach(view),
    server,
    meta,
    sshMeta,
    folders,
    exits,
    fenced,
    viewing,
    // The runtime feeds the same batch to the detector (titles) and the producer (bells).
    sideEffects: (
      facts: TerminalSideEffectFact[],
      extra: { pane?: string; ptyId?: string; connectionId?: string } = {}
    ) => {
      const batch = {
        ptyId: extra.ptyId ?? 'pty-t',
        seq: 1,
        facts,
        worktreeId: WT,
        paneKey: extra.pane ?? TITLE_PANE,
        ...(extra.connectionId ? { connectionId: extra.connectionId } : {})
      }
      detector.noteTerminalSideEffects(batch)
      listener({ type: 'terminalSideEffects', batch })
    }
  }
}

function advance(ms: number): number {
  vi.setSystemTime(Date.now() + ms)
  return Date.now()
}

function hook(
  server: AgentHookServer,
  state: 'working' | 'blocked' | 'waiting' | 'done',
  worktreeId = WT
): void {
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-a',
    worktreeId,
    payload: { state, prompt: 'task', agentType: 'codex' }
  })
}

function ingestRow(server: AgentHookServer, row: AgentTransitionStep['row']): void {
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-a',
    worktreeId: WT,
    payload: { ...row, prompt: 'task', agentType: 'codex' }
  })
}

function title(rawTitle: string): Extract<TerminalSideEffectFact, { kind: 'title' }> {
  return { kind: 'title', normalizedTitle: rawTitle, rawTitle }
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SortStampsProducer: hook agents', () => {
  it('stamps prompt, finish and needs-input, and holds Done until the next prompt', () => {
    const h = createHarness()
    h.attach(h.server)

    hook(h.server, 'working')
    expect(h.meta.get(WT)).toEqual({ lastActivityAt: T0, smartTier: 'working', smartAt: T0 })

    const finishedAt = advance(20_000)
    hook(h.server, 'done')
    expect(h.meta.get(WT)).toEqual({
      lastActivityAt: finishedAt,
      smartTier: 'done',
      smartAt: finishedAt
    })

    advance(20_000)
    hook(h.server, 'working')
    const askedAt = advance(20_000)
    hook(h.server, 'blocked')
    expect(h.meta.get(WT)).toEqual({
      lastActivityAt: askedAt,
      smartTier: 'needs-you',
      smartAt: askedAt
    })

    // Resuming after the approval is the same turn: Working, no Recent stamp, the ask's time.
    advance(20_000)
    hook(h.server, 'working')
    expect(h.meta.get(WT)).toEqual({
      lastActivityAt: askedAt,
      smartTier: 'working',
      smartAt: askedAt
    })
  })

  it('seeds a status present at attach: the tier is reconciled, Recent is not stamped', () => {
    const h = createHarness()
    hook(h.server, 'working')
    h.attach(h.server)
    expect(h.meta.get(WT)).toEqual({ lastActivityAt: 0, smartTier: 'working', smartAt: T0 })

    // The seeded pane is known, so its finish is a transition.
    const doneAt = advance(20_000)
    hook(h.server, 'done')
    expect(h.meta.get(WT)).toEqual({ lastActivityAt: doneAt, smartTier: 'done', smartAt: doneAt })
  })

  it('drops to Rest without a Recent stamp when the agent’s row goes', () => {
    const h = createHarness()
    h.attach(h.server)
    hook(h.server, 'working')
    advance(20_000)
    hook(h.server, 'done')
    const { lastActivityAt } = h.meta.get(WT)!
    advance(20_000)
    h.server.clearPaneState(PANE)
    expect(h.meta.get(WT)).toEqual({ lastActivityAt, smartTier: undefined, smartAt: undefined })
  })
})

describe('SortStampsProducer: terminal events', () => {
  it('turns a hookless agent’s titles into the same transitions', () => {
    const h = createHarness()
    h.attach(h.server)
    // The first title seeds the tier without a Recent stamp: it may be a terminal reattached.
    h.sideEffects([title('⠋ Codex working')])
    expect(h.meta.get(WT)).toEqual({ lastActivityAt: 0, smartTier: 'working', smartAt: T0 })

    const doneAt = advance(20_000)
    h.sideEffects([title('Codex')])
    expect(h.meta.get(WT)).toEqual({ lastActivityAt: doneAt, smartTier: 'done', smartAt: doneAt })

    const promptAt = advance(20_000)
    h.sideEffects([title('⠋ Codex working')])
    expect(h.meta.get(WT)).toEqual({
      lastActivityAt: promptAt,
      smartTier: 'working',
      smartAt: promptAt
    })

    // The agent leaves with its terminal.
    advance(20_000)
    h.exits.get('pty-t')!()
    expect(h.meta.get(WT)).toEqual({
      lastActivityAt: promptAt,
      smartTier: undefined,
      smartAt: undefined
    })
  })

  it('reads a cleared stale working title as Rest, not a finish', () => {
    const h = createHarness()
    h.sideEffects([title('⠋ Codex working')])
    advance(20_000)
    h.sideEffects([{ ...title('Codex'), staleWorkingTitleClear: true }])
    expect(h.meta.get(WT)).toEqual({ lastActivityAt: 0, smartTier: undefined, smartAt: undefined })
  })

  it('treats a new PTY in the pane as a new agent', () => {
    const h = createHarness()
    h.sideEffects([title('⠋ Codex working')])
    advance(20_000)
    h.sideEffects([title('⠋ Codex working')], { ptyId: 'pty-2' })
    expect(h.exits.has('pty-t')).toBe(false)
    // Its finish is a transition, and its own exit ends it.
    const doneAt = advance(20_000)
    h.sideEffects([title('Codex')], { ptyId: 'pty-2' })
    expect(h.meta.get(WT)).toEqual({ lastActivityAt: doneAt, smartTier: 'done', smartAt: doneAt })
    h.exits.get('pty-2')!()
    expect(h.meta.get(WT)?.smartTier).toBeUndefined()
  })

  // A pane its title tracked is handed to hooks by their first row, whatever that row says.
  it('hands a title-tracked pane to its first hook row: a finish stamps Done', () => {
    const h = createHarness()
    h.attach(h.server)
    h.sideEffects([title('⠋ Codex working')], { pane: PANE })
    expect(h.meta.get(WT)?.smartTier).toBe('working')
    const doneAt = advance(20_000)
    hook(h.server, 'done')
    expect(h.meta.get(WT)).toEqual({ lastActivityAt: doneAt, smartTier: 'done', smartAt: doneAt })
  })

  it('hands a title-tracked pane to its first hook row: no workspace rests it where it was', () => {
    const h = createHarness()
    h.attach(h.server)
    h.sideEffects([title('⠋ Codex working')], { pane: PANE })
    expect(h.meta.get(WT)?.smartTier).toBe('working')
    advance(20_000)
    h.server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-a',
      payload: { state: 'working', prompt: 'task', agentType: 'codex' }
    })
    expect(h.meta.get(WT)?.smartTier).toBeUndefined()
  })

  it('moves a pane to the workspace of a row present at attach, keeping that tier', () => {
    const h = createHarness()
    h.server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-a',
      worktreeId: FOLDER,
      payload: { state: 'working', prompt: 'task', agentType: 'codex' }
    })
    h.sideEffects([title('⠋ Codex working')], { pane: PANE })
    expect(h.meta.get(WT)?.smartTier).toBe('working')
    h.attach(h.server)
    expect(h.meta.get(WT)?.smartTier).toBeUndefined()
    expect(h.folders.get(FOLDER_ID)?.smartTier).toBe('working')
  })

  it('keeps a pane its first hook row finished in step: a later stop clears Done', () => {
    const h = createHarness()
    h.attach(h.server)
    h.sideEffects([title('⠋ Codex working')], { pane: PANE })
    expect(h.meta.get(WT)?.smartTier).toBe('working')
    advance(20_000)
    hook(h.server, 'done')
    advance(20_000)
    ingestRow(h.server, { state: 'done', interrupted: true })
    expect(h.meta.get(WT)?.smartTier).toBeUndefined()
  })
})

describe('SortStampsProducer: startup reconcile', () => {
  function evidence(overrides: Partial<StoredTierEvidence> = {}): StoredTierEvidence {
    return {
      isLocalWorkspace: () => true,
      terminalPtyIds: () => [],
      probePtyLiveness: async () => false,
      ...overrides
    }
  }

  it('clears a local tier with no hook row and no terminal its provider can find', async () => {
    const h = createHarness()
    h.meta.set(WT, { lastActivityAt: 5, smartTier: 'working', smartAt: 4 })
    h.folders.set(FOLDER_ID, { lastActivityAt: 6, smartTier: 'done', smartAt: 3 })
    h.attach(h.server)
    await h.producer.reconcileStoredTiers(evidence({ terminalPtyIds: () => ['pty-dead'] }))
    expect(h.meta.get(WT)).toEqual({ lastActivityAt: 5, smartTier: undefined, smartAt: undefined })
    expect(h.folders.get(FOLDER_ID)).toEqual({
      lastActivityAt: 6,
      smartTier: undefined,
      smartAt: undefined
    })
  })

  it('keeps a tier a hook row, a live terminal or an unprovable one backs', async () => {
    const h = createHarness()
    h.meta.set(WT, { lastActivityAt: 5, smartTier: 'done', smartAt: 4 })
    h.folders.set(FOLDER_ID, { lastActivityAt: 6, smartTier: 'working', smartAt: 3 })
    h.server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-a',
      worktreeId: FOLDER,
      payload: { state: 'working', prompt: 'task', agentType: 'codex' }
    })
    h.attach(h.server)

    await h.producer.reconcileStoredTiers(
      evidence({
        terminalPtyIds: () => ['pty-live', 'pty-unknown'],
        probePtyLiveness: async (ptyId) => (ptyId === 'pty-live' ? false : null)
      })
    )

    expect(h.meta.get(WT)?.smartTier).toBe('done')
    expect(h.folders.get(FOLDER_ID)?.smartTier).toBe('working')
  })

  it('seeds hook rows hydrated after attach, so they are not taken for new events', async () => {
    const h = createHarness()
    // Hydration fills the store without a row mutation: the view shows rows the producer never heard of.
    const source = new AgentHookServer()
    source.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-a',
      worktreeId: WT,
      payload: { state: 'working', prompt: 'task', agentType: 'codex' }
    })
    let hydrated = false
    const view: AgentStatusStoreView = {
      getStatusSnapshot: () => (hydrated ? source.getStatusSnapshot() : []),
      getStatusSnapshotForPane: (paneKey) =>
        hydrated ? source.getStatusSnapshotForPane(paneKey) : [],
      subscribeStatusRowMutations: () => () => {},
      subscribeStatusFreshness: () => () => {}
    }
    h.attach(view)
    hydrated = true
    // Startup seeds them before the reconcile.
    h.detector.seedRestoredRows()
    await h.producer.reconcileStoredTiers(evidence())
    expect(h.meta.get(WT)).toEqual({ lastActivityAt: 0, smartTier: 'working', smartAt: T0 })
  })
})

describe('SortStampsProducer: a read Done beside a Working pane', () => {
  const OTHER_PANE = 'tab-b:44444444-4444-4444-8444-444444444444'
  function otherPane(server: AgentHookServer, state: 'working' | 'done'): void {
    server.ingestTerminalStatus({
      paneKey: OTHER_PANE,
      tabId: 'tab-b',
      worktreeId: WT,
      payload: { state, prompt: 'task', agentType: 'codex' }
    })
  }

  it('stamps Working when the finish lands where someone is looking', () => {
    const h = createHarness()
    h.attach(h.server)
    hook(h.server, 'working')
    const workingAt = advance(20_000)
    otherPane(h.server, 'working')
    advance(20_000)
    hook(h.server, 'done')
    expect(h.meta.get(WT)).toMatchObject({ smartTier: 'working', smartAt: workingAt })
  })
})
