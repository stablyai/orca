import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hooks/server'
import type { AgentStatusStoreView } from './workspace-activity-facts-producer'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { makeStructuredAgentStatusSubject } from '../../../shared/agent-status-subject'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import type { TerminalSideEffectFact } from '../../../shared/terminal-side-effect-facts'
import {
  RECENT_STAMP_THROTTLE_MS,
  type SmartStampFields
} from '../../../shared/sidebar-list/sort-stamps'
import {
  AGENT_TRANSITION_SCENARIOS,
  type AgentTransitionStep
} from '../../../shared/agent-transitions.test-fixture'
import { AgentTransitionDetector } from '../../agent-hooks/agent-transition-detector'
import {
  SortStampsProducer,
  type SortStampsStore,
  type StoredTierEvidence
} from './sort-stamps-producer'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

const WT = 'repo-1::/tmp/a'
const FOLDER_ID = '11111111-1111-4111-8111-111111111111'
const FOLDER = `folder:${FOLDER_ID}`
const PANE = 'tab-a:22222222-2222-4222-8222-222222222222'
const TITLE_PANE = 'tab-t:33333333-3333-4333-8333-333333333333'
const T0 = 1_000_000

type Stamps = { lastActivityAt: number; isUnread?: boolean } & SmartStampFields
const SSH_HOST = 'ssh:build-box'

function createHarness() {
  const meta = new Map<string, Stamps & { hostId?: string }>([[WT, { lastActivityAt: 0 }]])
  const sshMeta = new Map<string, Stamps>([[WT, { lastActivityAt: 0 }]])
  const folders = new Map<string, Stamps & { connectionId?: string }>([
    [FOLDER_ID, { lastActivityAt: 0 }]
  ])
  const writes: string[] = []
  const exits = new Map<string, () => void>()
  const fenced = new Set<string>()
  const notified: string[] = []
  let listener: (event: RuntimeClientEvent) => void = () => {}
  // Stamping tests watch every workspace, so no unread flag is raised; the unread tests unwatch.
  const viewing = { isViewing: (_id: string, _pane: string | null): boolean => true }
  const store: SortStampsStore = {
    getWorktreeMeta: (id) => meta.get(id),
    setWorktreeMeta: (id, updates) => {
      writes.push(id)
      meta.set(id, { lastActivityAt: 0, ...meta.get(id), ...updates })
    },
    getWorktreeMetaForHost: (id, hostId) => (hostId === SSH_HOST ? sshMeta.get(id) : undefined),
    setWorktreeMetaForHost: (id, hostId, updates) => {
      writes.push(`${hostId}|${id}`)
      sshMeta.set(id, { lastActivityAt: 0, ...sshMeta.get(id), ...updates })
    },
    getFolderWorkspace: (id) => folders.get(id),
    updateFolderWorkspace: (id, updates) => {
      writes.push(`folder:${id}`)
      folders.set(id, { lastActivityAt: 0, ...folders.get(id), ...updates })
    },
    getAllWorktreeMeta: () => Object.fromEntries(meta),
    getFolderWorkspaces: () => [...folders].map(([id, folder]) => ({ id, ...folder }))
  }
  const detector = new AgentTransitionDetector({
    resolveTabWorktreeId: (tabId) => (tabId === 'tab-t' ? WT : undefined),
    now: () => Date.now()
  })
  const producer = new SortStampsProducer({
    store: () => store,
    isWriteFenced: (id) => fenced.has(id),
    subscribeToPtyExit: (ptyId, onExit) => {
      exits.set(ptyId, onExit)
      return () => exits.delete(ptyId)
    },
    onClientEvent: (next, options) => {
      expect(options.consumesTerminalSideEffects).toBe(true)
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
    writes,
    exits,
    fenced,
    notified,
    viewing,
    sideEffects: (
      facts: TerminalSideEffectFact[],
      extra: { pane?: string; ptyId?: string; connectionId?: string } = {}
    ) =>
      listener({
        type: 'terminalSideEffects',
        batch: {
          ptyId: extra.ptyId ?? 'pty-t',
          seq: 1,
          facts,
          worktreeId: WT,
          paneKey: extra.pane ?? TITLE_PANE,
          ...(extra.connectionId ? { connectionId: extra.connectionId } : {})
        }
      })
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
    // Each write tells clients to re-list the record.
    expect(h.notified).toEqual([WT])

    const finishedAt = advance(20_000)
    hook(h.server, 'done')
    expect(h.meta.get(WT)).toEqual({
      lastActivityAt: finishedAt,
      smartTier: 'done',
      smartAt: finishedAt
    })

    const promptedAt = advance(20_000)
    hook(h.server, 'working')
    const askedAt = advance(20_000)
    hook(h.server, 'blocked')
    expect(h.meta.get(WT)).toEqual({
      lastActivityAt: askedAt,
      smartTier: 'needs-you',
      smartAt: askedAt
    })
    expect(promptedAt).toBeLessThan(askedAt)

    // Resuming after the approval is the same turn: Working, no Recent stamp, the ask's time.
    advance(20_000)
    hook(h.server, 'working')
    expect(h.meta.get(WT)).toEqual({
      lastActivityAt: askedAt,
      smartTier: 'working',
      smartAt: askedAt
    })
  })

  it('never stamps running to running, and throttles Recent while tiers apply at once', () => {
    const h = createHarness()
    h.attach(h.server)
    hook(h.server, 'working')
    const writes = h.writes.length
    advance(1_000)
    hook(h.server, 'working')
    expect(h.writes).toHaveLength(writes)

    const doneAt = advance(1_000)
    hook(h.server, 'done')
    expect(h.meta.get(WT)).toEqual({ lastActivityAt: T0, smartTier: 'done', smartAt: doneAt })
  })

  it('seeds a status present at attach: the tier is reconciled, Recent is not stamped', () => {
    const h = createHarness()
    hook(h.server, 'working')
    h.attach(h.server)
    expect(h.meta.get(WT)).toEqual({ lastActivityAt: 0, smartTier: 'working', smartAt: T0 })
    // Re-attaching after a restart finds the tier it stamped and writes nothing.
    const writes = h.writes.length
    h.attach(h.server)
    expect(h.writes).toHaveLength(writes)

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

  it('stamps a structured chat session through the same store', () => {
    const h = createHarness()
    h.attach(h.server)
    const subject = makeStructuredAgentStatusSubject(
      { executionHostId: 'local', wslDistro: null, workspaceId: FOLDER, workspaceKind: 'folder' },
      'structured-session-one'
    )
    const summary: AgentSessionStatusSummary = {
      sessionId: 'structured-session-one',
      workspaceId: FOLDER,
      agent: 'claude',
      status: 'working',
      hostExecutionOwned: true,
      latestPrompt: 'fix it',
      updatedAt: 100
    }
    h.server.ingestStructuredStatus(summary, subject)
    expect(h.folders.get(FOLDER_ID)).toEqual({
      lastActivityAt: T0,
      smartTier: 'working',
      smartAt: T0
    })
    const doneAt = advance(20_000)
    h.server.ingestStructuredStatus(
      { ...summary, status: 'idle', turnOutcome: 'success', updatedAt: 200 },
      subject
    )
    expect(h.folders.get(FOLDER_ID)).toEqual({
      lastActivityAt: doneAt,
      smartTier: 'done',
      smartAt: doneAt
    })
  })

  it('stamps an SSH workspace’s record on its own host', () => {
    const h = createHarness()
    h.attach(h.server)
    h.server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-a',
      worktreeId: WT,
      connectionId: 'build-box',
      payload: { state: 'waiting', prompt: 'task', agentType: 'codex' }
    })
    expect(h.sshMeta.get(WT)).toEqual({ lastActivityAt: T0, smartTier: 'needs-you', smartAt: T0 })
    expect(h.meta.get(WT)).toEqual({ lastActivityAt: 0 })
    h.sideEffects([{ kind: 'bell' }], { connectionId: 'build-box' })
    expect(h.writes).toEqual([`${SSH_HOST}|${WT}`])
  })

  it('drops stamps while a WSL move freezes the project', () => {
    const h = createHarness()
    h.fenced.add(WT)
    h.attach(h.server)
    hook(h.server, 'working')
    h.sideEffects([{ kind: 'bell' }])
    expect(h.writes).toEqual([])
  })

  it('writes nothing for a workspace with no record', () => {
    const h = createHarness()
    h.attach(h.server)
    hook(h.server, 'working', 'repo-1::/tmp/gone')
    expect(h.writes).toEqual([])
  })
})

describe('SortStampsProducer: the agent transitions', () => {
  it.each(AGENT_TRANSITION_SCENARIOS)('$name', ({ steps }) => {
    const h = createHarness()
    h.viewing.isViewing = () => false
    h.attach(h.server)
    for (const { row, transition } of steps) {
      const at = advance(RECENT_STAMP_THROTTLE_MS)
      h.meta.set(WT, { ...h.meta.get(WT)!, isUnread: false })
      ingestRow(h.server, row)
      const stamps = h.meta.get(WT)
      expect(stamps?.lastActivityAt === at).toBe(transition !== null)
      expect(stamps?.isUnread).toBe(transition !== null && transition !== 'prompt-submitted')
    }
  })
})

describe('SortStampsProducer: terminal events', () => {
  it('stamps a bell', () => {
    const h = createHarness()
    h.sideEffects([{ kind: 'bell' }])
    expect(h.meta.get(WT)).toEqual({ lastActivityAt: T0 })
  })

  it('stamps a terminal start', () => {
    const h = createHarness()
    h.producer.noteTerminalStarted(FOLDER, undefined)
    expect(h.folders.get(FOLDER_ID)).toEqual({ lastActivityAt: T0 })
  })

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

  it('does not read an agent idle at its first title as Done', () => {
    const h = createHarness()
    h.sideEffects([title('Codex')])
    expect(h.writes).toEqual([])
    const promptAt = advance(20_000)
    h.sideEffects([title('⠋ Codex working')])
    expect(h.meta.get(WT)).toEqual({
      lastActivityAt: promptAt,
      smartTier: 'working',
      smartAt: promptAt
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

  it('leaves a pane with hook rows to its hooks', () => {
    const h = createHarness()
    h.attach(h.server)
    hook(h.server, 'working')
    const writes = h.writes.length
    h.sideEffects([title('⠋ Codex working')], { pane: PANE })
    expect(h.meta.get(WT)?.smartTier).toBe('working')
    advance(20_000)
    h.sideEffects([title('Codex')], { pane: PANE })
    expect(h.writes).toHaveLength(writes)
    expect(h.meta.get(WT)?.smartTier).toBe('working')
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

  it('hands a title-tracked pane to its first hook row: a stopped turn rests it', () => {
    const h = createHarness()
    h.attach(h.server)
    h.sideEffects([title('⠋ Codex working')], { pane: PANE })
    expect(h.meta.get(WT)?.smartTier).toBe('working')
    advance(20_000)
    ingestRow(h.server, { state: 'done', interrupted: true })
    expect(h.meta.get(WT)?.smartTier).toBeUndefined()
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

  it('hands a title-tracked pane to a row present at attach with no workspace: it rests', () => {
    const h = createHarness()
    h.server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-a',
      payload: { state: 'working', prompt: 'task', agentType: 'codex' }
    })
    h.sideEffects([title('⠋ Codex working')], { pane: PANE })
    expect(h.meta.get(WT)?.smartTier).toBe('working')
    h.attach(h.server)
    expect(h.meta.get(WT)?.smartTier).toBeUndefined()
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
    const writes = h.writes.length
    await h.producer.reconcileStoredTiers(
      evidence({
        terminalPtyIds: () => ['pty-live', 'pty-unknown'],
        probePtyLiveness: async (ptyId) => (ptyId === 'pty-live' ? false : null)
      })
    )
    expect(h.writes).toHaveLength(writes)
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

  it('keeps a tier when no terminal is on record: that proves nothing', async () => {
    const h = createHarness()
    h.meta.set(WT, { lastActivityAt: 5, smartTier: 'done', smartAt: 4 })
    h.attach(h.server)
    await h.producer.reconcileStoredTiers(evidence())
    expect(h.writes).toEqual([])
  })

  it('leaves another host’s tiers alone: a host not reached yet is not one whose agents died', async () => {
    const h = createHarness()
    h.meta.set(WT, { lastActivityAt: 5, smartTier: 'working', smartAt: 4 })
    h.attach(h.server)
    await h.producer.reconcileStoredTiers(evidence({ isLocalWorkspace: () => false }))
    expect(h.writes).toEqual([])
  })
})

describe('SortStampsProducer: unread flag', () => {
  function unwatched() {
    const h = createHarness()
    h.viewing.isViewing = () => false
    h.attach(h.server)
    return h
  }

  it('raises the flag on a finish, a request for input and a bell; never on a prompt', () => {
    const h = unwatched()
    hook(h.server, 'working')
    expect(h.meta.get(WT)?.isUnread).toBeUndefined()

    advance(20_000)
    hook(h.server, 'done')
    expect(h.meta.get(WT)?.isUnread).toBe(true)
    // The stamps and the flag are one change to the record.
    expect(h.notified).toEqual([WT, WT])

    for (const news of [() => hook(h.server, 'blocked'), () => h.sideEffects([{ kind: 'bell' }])]) {
      h.meta.set(WT, { ...h.meta.get(WT)!, isUnread: false })
      hook(h.server, 'working')
      news()
      expect(h.meta.get(WT)?.isUnread).toBe(true)
    }

    // A flag already up is not written again.
    const writes = h.writes.length
    h.sideEffects([{ kind: 'bell' }])
    expect(h.writes).toHaveLength(writes)
  })

  it('leaves the flag down where someone is looking: the pane’s tab, or a bell’s workspace', () => {
    const h = unwatched()
    const seen: [string, string | null][] = []
    h.viewing.isViewing = (id, pane) => {
      seen.push([id, pane])
      return pane === PANE
    }
    hook(h.server, 'working')
    advance(20_000)
    hook(h.server, 'done')
    expect(h.meta.get(WT)?.isUnread).toBeUndefined()

    h.sideEffects([{ kind: 'bell' }])
    expect(h.meta.get(WT)?.isUnread).toBe(true)
    expect(seen).toEqual([
      [WT, PANE],
      [WT, TITLE_PANE]
    ])
  })

  it('raises an SSH workspace’s flag on its own host’s record, and a folder’s on the folder', () => {
    const h = unwatched()
    h.sideEffects([{ kind: 'bell' }], { connectionId: 'build-box' })
    expect(h.sshMeta.get(WT)?.isUnread).toBe(true)
    expect(h.meta.get(WT)?.isUnread).toBeUndefined()

    h.server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-a',
      worktreeId: FOLDER,
      payload: { state: 'waiting', prompt: 'task', agentType: 'codex' }
    })
    expect(h.folders.get(FOLDER_ID)?.isUnread).toBe(true)
  })

  it('raises nothing for a restored status, a frozen project or a workspace with no record', () => {
    const h = createHarness()
    h.viewing.isViewing = () => false
    hook(h.server, 'blocked')
    h.attach(h.server)
    expect(h.meta.get(WT)?.isUnread).toBeUndefined()

    h.fenced.add(WT)
    h.sideEffects([{ kind: 'bell' }])
    expect(h.meta.get(WT)?.isUnread).toBeUndefined()

    hook(h.server, 'done', 'repo-1::/tmp/gone')
    expect(h.writes).not.toContain('repo-1::/tmp/gone')
  })
})
