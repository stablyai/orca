import { describe, expect, it, vi } from 'vitest'
import type { TerminalSideEffectBatch } from '../../../shared/terminal-side-effect-facts'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store,
  syncSinglePty,
  TEST_WORKTREE_ID,
  HEADLESS_LEAF_ID
} from '../orca-runtime-test-fixtures.spec'
import { createSideEffectRuntime } from '../orca-runtime-test-scenario-builders.spec'
import { OrcaRuntimeService } from '../orca-runtime'

const AGENT_AUTHORED_TITLE = 'π - replacement-test'

type AdmissionRuntime = ReturnType<typeof createSideEffectRuntime>['runtime']

const PTY = 'pty-1'
const OLD = 'inc-old'
const NEW = 'inc-new'

function feed(
  runtime: AdmissionRuntime,
  data: string,
  at: number,
  incarnationId?: string,
  ptyId = PTY
): number {
  return runtime.onPtyData(ptyId, data, at, data.length, false, undefined, undefined, incarnationId)
}

/** A stable-pane leaf id is a UUID; only that shape makes registerPty publish a mobile surface. */
const PUBLISHING_LEAF_ID = '11111111-2222-4333-8444-555555555555'

function bind(
  runtime: AdmissionRuntime,
  incarnationId: string,
  admission?: unknown,
  leafId = 'pane:1'
): void {
  runtime.registerPty(
    PTY,
    TEST_WORKTREE_ID,
    null,
    { tabId: 'tab-1', leafId, incarnationId },
    undefined,
    admission as never
  )
}

function record(runtime: AdmissionRuntime): {
  lastOscTitle: string | null
  lastAgentStatus: string | null
} {
  const pty = runtime['ptysById'].get(PTY)
  return {
    lastOscTitle: pty?.lastOscTitle ?? null,
    lastAgentStatus: pty?.lastAgentStatus ?? null
  }
}

type Stamped = { stamp: { ingestionOrdinal: number; chunkOrder: number } }

/** The candidate's reduced evidence, read straight off the capsule store. */
function summaryOf(
  runtime: AdmissionRuntime,
  incarnationId = NEW
): {
  title: Stamped | null
  cwd: Stamped | null
  lifecycle: (Stamped & { value: unknown }) | null
} | null {
  const capsules = runtime['ptyObservationCapsulesByPtyId'].get(PTY)
  return capsules?.get(`id\u0000${incarnationId}`)?.summary ?? null
}

function titleFacts(batches: TerminalSideEffectBatch[]): string[] {
  return batches
    .flatMap((batch) => batch.facts)
    .filter((fact) => fact.kind === 'title')
    .map((fact) => (fact as { rawTitle: string }).rawTitle)
}

/** Accepted binding for PTY with an already-admitted `inc-old` live title. */
function acceptedPredecessor(): {
  runtime: AdmissionRuntime
  batches: TerminalSideEffectBatch[]
} {
  const { runtime, batches } = createSideEffectRuntime()
  syncSinglePty(runtime)
  bind(runtime, OLD)
  feed(runtime, '\x1b]0;Codex working\x07', 100, OLD)
  batches.length = 0
  return { runtime, batches }
}

describe('runtime PTY observation admission', () => {
  it('keeps an accepted same-incarnation attach on the ordinary live path', () => {
    const { runtime, batches } = acceptedPredecessor()
    const token = runtime.beginPtyObservationAdmission(PTY)

    feed(runtime, '\x1b]0;Codex done\x07', 101, OLD)

    // Same source: no candidate capsule, live records move immediately.
    expect(record(runtime).lastOscTitle).toBe('Codex done')
    expect(titleFacts(batches)).toEqual(['Codex done'])
    runtime.cancelPtyObservationAdmission(token)
  })

  it('withholds a known replacement source until admission, then promotes it once', () => {
    const { runtime, batches } = acceptedPredecessor()
    const token = runtime.beginPtyObservationAdmission(PTY)

    feed(runtime, '\x1b]0;Claude working\x07', 101, NEW)

    expect(record(runtime)).toEqual({ lastOscTitle: 'Codex working', lastAgentStatus: 'working' })
    expect(titleFacts(batches)).toEqual([])

    const prepared = runtime.preparePtyObservationAdmission(token, PTY, NEW)
    bind(runtime, NEW, prepared)

    expect(record(runtime)).toEqual({ lastOscTitle: 'Claude working', lastAgentStatus: 'working' })
  })

  it('resumes live title and side-effect processing on the promoted capsule', () => {
    const { runtime, batches } = acceptedPredecessor()
    const token = runtime.beginPtyObservationAdmission(PTY)
    feed(runtime, '\x1b]0;Claude working\x07', 101, NEW)
    const prepared = runtime.preparePtyObservationAdmission(token, PTY, NEW)
    bind(runtime, NEW, prepared)
    batches.length = 0

    feed(runtime, '\x1b]0;Claude done\x07', 102, NEW)

    // The promoted capsule is now the live tracker: its callbacks must act, not record.
    expect(record(runtime)).toEqual({ lastOscTitle: 'Claude done', lastAgentStatus: 'idle' })
    expect(titleFacts(batches)).toEqual(['Claude done'])
    expect(batches.flatMap((batch) => batch.facts).map((fact) => fact.kind)).toContain('agent-idle')
  })

  it('makes the promoted capsule parser state the accepted state, carries included', () => {
    const { runtime } = acceptedPredecessor()
    const token = runtime.beginPtyObservationAdmission(PTY)
    feed(runtime, '\x1b]0;Claude working\x07\x1b]0;Claude do', 101, NEW)
    const capsule = runtime['ptyObservationCapsulesByPtyId'].get(PTY)?.get(`id\u0000${NEW}`)

    const prepared = runtime.preparePtyObservationAdmission(token, PTY, NEW)
    bind(runtime, NEW, prepared)

    // The capsule's OSC 9999 processor has no callbacks to freeze, but it must
    // still become the accepted one, and its OSC-title carry must survive.
    expect(runtime['agentStatusOscProcessorsByPtyId'].get(PTY)).toBe(capsule?.agentStatusProcessor)
    feed(runtime, 'ne\x07', 102, NEW)
    expect(record(runtime).lastOscTitle).toBe('Claude done')
  })

  it('still fences a promoted capsule tracker once it is retired', () => {
    const { runtime, batches } = acceptedPredecessor()
    const token = runtime.beginPtyObservationAdmission(PTY)
    feed(runtime, '\x1b]0;Claude working\x07', 101, NEW)
    const prepared = runtime.preparePtyObservationAdmission(token, PTY, NEW)
    bind(runtime, NEW, prepared)
    const promoted = runtime['getOrCreatePtyTitleTrackerEntry'](PTY)

    runtime['disposePtyTitleTracker'](PTY)
    batches.length = 0
    // Delegation is fenced on the capsule's OWN entry, so a retired promoted
    // tracker (or its 3s stale-title timer) cannot act through the successor.
    promoted.tracker.handleChunk('\x1b]0;Retired promoted frame\x07')

    expect(titleFacts(batches)).toEqual([])
    expect(record(runtime).lastOscTitle).toBe('Claude working')
  })

  it('promotes an early final title over a later intermediate one from the same source', () => {
    const { runtime } = acceptedPredecessor()
    const token = runtime.beginPtyObservationAdmission(PTY)

    feed(runtime, '\x1b]0;Claude working\x07', 101, NEW)
    feed(runtime, '\x1b]0;Claude done\x07', 102, NEW)
    feed(runtime, '\x1b]0;Codex working\x07', 103, OLD)

    const prepared = runtime.preparePtyObservationAdmission(token, PTY, NEW)
    bind(runtime, NEW, prepared)

    // The late predecessor chunk parsed into its own capsule and lost with it.
    expect(record(runtime).lastOscTitle).toBe('Claude done')
  })

  it('keeps an early successor title identical to the predecessor through retirement', () => {
    const { runtime } = acceptedPredecessor()
    const token = runtime.beginPtyObservationAdmission(PTY)

    feed(runtime, '\x1b]0;Codex working\x07', 101, NEW)
    // The pre-commit generation reset must not clear what the candidate already proved.
    runtime.synchronizePtyOutputSequenceFromProvider(PTY, { value: 0, generation: 'reset' }, 0)

    const prepared = runtime.preparePtyObservationAdmission(token, PTY, NEW)
    bind(runtime, NEW, prepared)

    expect(record(runtime)).toEqual({ lastOscTitle: 'Codex working', lastAgentStatus: 'working' })
  })

  it('isolates OSC title, OSC 7, OSC 9999 and OSC 133 frames split across sources', () => {
    const { runtime, batches } = acceptedPredecessor()
    const token = runtime.beginPtyObservationAdmission(PTY)

    feed(runtime, '\x1b]0;Codex ', 101, OLD)
    feed(runtime, 'Claude working\x07', 102, NEW)
    feed(runtime, '\x1b]133;D;0', 103, OLD)
    feed(runtime, '\x07', 104, NEW)
    feed(runtime, '\x1b]7;file://host/tmp/from-new\x07', 105, NEW)
    feed(runtime, '\x1b]9999;{"state":"done","prompt":"ok"}\x1b\\', 106, NEW)

    // No cross-source completion: neither half finished the other's frame.
    expect(titleFacts(batches)).toEqual([])
    expect(batches.flatMap((batch) => batch.facts).map((fact) => fact.kind)).toEqual([])
    expect(record(runtime).lastOscTitle).toBe('Codex working')
    expect(runtime['terminalCwdByPtyId'].get(PTY)).toBeUndefined()

    const prepared = runtime.preparePtyObservationAdmission(token, PTY, NEW)
    bind(runtime, NEW, prepared)
    expect(runtime['terminalCwdByPtyId'].get(PTY)).toBe('/tmp/from-new')
  })

  it('scopes marker and gap resets to the observing source', () => {
    const { runtime } = acceptedPredecessor()
    const token = runtime.beginPtyObservationAdmission(PTY)

    feed(runtime, '\x1b]0;Codex bu', 101, OLD)
    feed(runtime, 'candidate bytes', 102, NEW)
    const headless = runtime['headlessTerminals'] as Map<string, unknown>
    expect(headless.has(PTY)).toBe(true)

    runtime.notePtyDataGap(PTY, 4, NEW)

    // The candidate's bytes DID reach the shared headless mirror, so its gap
    // invalidates that mirror; the accepted source's tail carry is untouched.
    expect(headless.has(PTY)).toBe(false)
    expect(runtime['ptysById'].get(PTY)?.tailPendingAnsi).toBe('\x1b]0;Codex bu')
    // The candidate's discontinuity did not drop the accepted parser's carry.
    feed(runtime, 'sy\x07', 103, OLD)
    expect(record(runtime).lastOscTitle).toBe('Codex busy')
    runtime.cancelPtyObservationAdmission(token)
  })

  it('stamps candidate observations in the order the capsule recorded them', () => {
    const { runtime } = acceptedPredecessor()
    const token = runtime.beginPtyObservationAdmission(PTY)

    feed(
      runtime,
      '\x1b]7;file://host/tmp/from-new\x07\x1b]0;Claude working\x07\x1b]133;D;0\x07',
      101,
      NEW
    )

    const first = summaryOf(runtime)
    // One chunk, one ingestion ordinal, strictly increasing intra-chunk order:
    // CWD, then the title, then the completion the tracker drains after titles.
    expect(first?.cwd?.stamp.ingestionOrdinal).toBe(first?.title?.stamp.ingestionOrdinal)
    expect(first?.cwd?.stamp.chunkOrder).toBe(0)
    expect(first?.title?.stamp.chunkOrder).toBe(1)
    expect(first?.lifecycle?.stamp.chunkOrder).toBe(2)
    expect(first?.lifecycle?.value).toEqual({ kind: 'command-finished', exitCode: 0 })
    const firstChunkOrdinal = first!.lifecycle!.stamp.ingestionOrdinal

    feed(runtime, '\x1b]0;Claude done\x07', 102, NEW)

    const second = summaryOf(runtime)
    // The counter restarts per chunk, so a later chunk wins on ingestion ordinal.
    expect(second?.title?.stamp.chunkOrder).toBe(0)
    expect(second?.title?.stamp.ingestionOrdinal).toBeGreaterThan(firstChunkOrdinal)
    expect(second?.lifecycle?.value).toEqual({ kind: 'agent-status', status: 'idle' })
    runtime.cancelPtyObservationAdmission(token)
  })

  it('keeps a legacy untagged stream on conservative live behavior', () => {
    const { runtime, batches } = acceptedPredecessor()
    const token = runtime.beginPtyObservationAdmission(PTY)

    feed(runtime, '\x1b]0;Legacy shell\x07', 101)

    expect(record(runtime).lastOscTitle).toBe('Legacy shell')
    expect(titleFacts(batches)).toEqual(['Legacy shell'])
    // An omitted source is never relabelled as the replacement by the reply.
    expect(runtime.preparePtyObservationAdmission(token, PTY, NEW)?.capsule).toBeNull()
  })

  it('never lets an unknown stream clear known accepted state through a mixed window', () => {
    const { runtime } = acceptedPredecessor()
    const token = runtime.beginPtyObservationAdmission(PTY)

    feed(runtime, '\x1b]0;Claude working\x07', 101, NEW)
    feed(runtime, 'plain untagged output\r\n', 102)

    expect(record(runtime)).toEqual({ lastOscTitle: 'Codex working', lastAgentStatus: 'working' })
    runtime.cancelPtyObservationAdmission(token)
  })

  it('records a later activity over an earlier completion without publishing an exit', () => {
    const { runtime, batches } = acceptedPredecessor()
    const token = runtime.beginPtyObservationAdmission(PTY)

    runtime.emitDaemonPtyTransientFact(PTY, { kind: 'command-finished', exitCode: 0 }, NEW)
    feed(runtime, '\x1b]0;Claude working\x07', 101, NEW)

    const prepared = runtime.preparePtyObservationAdmission(token, PTY, NEW)
    bind(runtime, NEW, prepared)

    expect(record(runtime)).toEqual({ lastOscTitle: 'Claude working', lastAgentStatus: 'working' })
    // Known replacement implies neither a shell handover nor an exit.
    expect(batches.flatMap((batch) => batch.facts).map((fact) => fact.kind)).not.toContain(
      'command-finished'
    )
  })

  it('lets the first registration publication see the promoted observations', () => {
    const { runtime } = acceptedPredecessor()
    const token = runtime.beginPtyObservationAdmission(PTY)
    feed(runtime, '\x1b]0;Claude working\x07', 101, NEW)

    const titlesAtPublication: (string | null)[] = []
    const publish = runtime['ensurePtyBackedMobileSurfaceForRendererTab'].bind(runtime)
    runtime['ensurePtyBackedMobileSurfaceForRendererTab'] = (
      worktreeId: string,
      tabId: string
    ): ReturnType<typeof publish> => {
      titlesAtPublication.push(record(runtime).lastOscTitle)
      return publish(worktreeId, tabId)
    }

    const prepared = runtime.preparePtyObservationAdmission(token, PTY, NEW)
    bind(runtime, NEW, prepared, PUBLISHING_LEAF_ID)

    expect(titlesAtPublication).toEqual(['Claude working'])
  })

  it('continues raw delivery and sequence accounting while admission is withheld', () => {
    const { runtime } = acceptedPredecessor()
    const token = runtime.beginPtyObservationAdmission(PTY)
    const delivered: { data: string; seq: number | undefined }[] = []
    const unsubscribe = runtime.subscribeToTerminalData(PTY, (data, meta) => {
      delivered.push({ data, seq: meta?.seq })
    })
    const before = runtime.getPtyOutputSequence(PTY)

    const returned = feed(runtime, 'candidate bytes', 101, NEW)

    expect(returned).toBe(before + 'candidate bytes'.length)
    expect(runtime.getPtyOutputSequence(PTY)).toBe(returned)
    expect(delivered).toEqual([{ data: 'candidate bytes', seq: returned }])
    unsubscribe()
    runtime.cancelPtyObservationAdmission(token)
  })

  it('preserves accepted state when the admission is cancelled or its token is stale', () => {
    const { runtime } = acceptedPredecessor()
    const token = runtime.beginPtyObservationAdmission(PTY)
    feed(runtime, '\x1b]0;Claude working\x07', 101, NEW)

    runtime.cancelPtyObservationAdmission(token)
    expect(record(runtime).lastOscTitle).toBe('Codex working')

    // Duplicate and stale tokens prepare nothing and promote nothing.
    expect(runtime.preparePtyObservationAdmission(token, PTY, NEW)).toBeNull()
    runtime.acceptPtyObservationAdmission({ token, ptyId: PTY, incarnationId: NEW, capsule: null })
    expect(record(runtime).lastOscTitle).toBe('Codex working')
  })

  it('discards a held-back generation reset when the spawn fails', () => {
    const { runtime } = acceptedPredecessor()
    const token = runtime.beginPtyObservationAdmission(PTY)

    runtime.synchronizePtyOutputSequenceFromProvider(PTY, { value: 0, generation: 'reset' }, 0)
    // Held back, so the accepted title survives a failed spawn instead of being wiped early.
    expect(record(runtime).lastOscTitle).toBe('Codex working')

    runtime.cancelPtyObservationAdmission(token)
    expect(record(runtime).lastOscTitle).toBe('Codex working')
  })

  it('fails closed past the audited candidate bound without touching accepted state', () => {
    const { runtime } = acceptedPredecessor()
    const token = runtime.beginPtyObservationAdmission(PTY)

    for (const incarnation of ['inc-1', 'inc-2', 'inc-3', 'inc-4', 'inc-5']) {
      feed(runtime, `\x1b]0;Attempt ${incarnation}\x07`, 101, incarnation)
    }

    expect(record(runtime).lastOscTitle).toBe('Codex working')
    expect(() => runtime.preparePtyObservationAdmission(token, PTY, 'inc-5')).toThrow(
      'pty_observation_capacity_exceeded'
    )
    // The refusal happens before any binding write, so the accepted source is untouched.
    expect(record(runtime)).toEqual({ lastOscTitle: 'Codex working', lastAgentStatus: 'working' })
    runtime.cancelPtyObservationAdmission(token)
    expect(record(runtime).lastOscTitle).toBe('Codex working')
  })

  it('transfers candidate ownership when the canonical PTY id differs', () => {
    const { runtime } = acceptedPredecessor()
    const token = runtime.beginPtyObservationAdmission('pty-requested')
    feed(runtime, '\x1b]0;Stale request\x07', 101, NEW, 'pty-requested')

    const transferred = runtime.transferPtyObservationAdmission(token, PTY)
    feed(runtime, '\x1b]0;Claude working\x07', 102, NEW)

    // Evidence observed under the requested id cannot reach the canonical owner.
    expect(runtime['ptyObservationCapsulesByPtyId'].has('pty-requested')).toBe(false)
    const prepared = runtime.preparePtyObservationAdmission(transferred, PTY, NEW)
    bind(runtime, NEW, prepared)
    expect(record(runtime).lastOscTitle).toBe('Claude working')
  })

  it('drops a contested transfer token instead of stranding it by token', () => {
    const { runtime } = acceptedPredecessor()
    const incumbent = runtime.beginPtyObservationAdmission(PTY)
    const contender = runtime.beginPtyObservationAdmission('pty-requested')

    // The canonical id already has an owner, so the contender's token is dead.
    expect(runtime.transferPtyObservationAdmission(contender, PTY)).toBe(incumbent)

    const byToken = runtime['pendingPtyObservationAdmissionsByToken'] as Map<string, unknown>
    expect(byToken.has(contender)).toBe(false)
    expect([...byToken.keys()]).toEqual([incumbent])
    runtime.cancelPtyObservationAdmission(incumbent)
    expect(byToken.size).toBe(0)
  })

  it('fences a retired tracker callback out of its successor map entry', () => {
    const { runtime, batches } = acceptedPredecessor()
    const retired = runtime['getOrCreatePtyTitleTrackerEntry'](PTY)

    runtime['disposePtyTitleTracker'](PTY)
    const successor = runtime['getOrCreatePtyTitleTrackerEntry'](PTY)
    expect(successor).not.toBe(retired)
    batches.length = 0

    retired.tracker.handleChunk('\x1b]0;Retired frame\x07')

    expect(titleFacts(batches)).toEqual([])
    expect(record(runtime).lastOscTitle).toBe('Codex working')
  })

  it('does not let a retired stale-title timer clear the successor status', () => {
    vi.useFakeTimers()
    try {
      const { runtime } = acceptedPredecessor()
      const retired = runtime['getOrCreatePtyTitleTrackerEntry'](PTY)
      runtime['disposePtyTitleTracker'](PTY)
      runtime['getOrCreatePtyTitleTrackerEntry'](PTY)
      feed(runtime, '\x1b]0;Claude working\x07', 101, OLD)

      retired.tracker.handleChunk('\x1b]0;Codex working\x07')
      vi.advanceTimersByTime(10_000)

      expect(record(runtime)).toEqual({
        lastOscTitle: 'Claude working',
        lastAgentStatus: 'working'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a cold-restore seed once an admitted live title exists', () => {
    const { runtime } = acceptedPredecessor()

    runtime['applySeededAgentStatus'](PTY, 'Restored predecessor title')

    expect(record(runtime)).toEqual({ lastOscTitle: 'Codex working', lastAgentStatus: 'working' })
    expect(store).toBeDefined()
  })
})

/** A session whose durable binding names `PTY` with an already-exited predecessor incarnation. */
function sessionWithDurablePredecessor(incarnationId: string): WorkspaceSessionState {
  const base = makeWorkspaceSessionWithHeadlessTerminal()
  return {
    ...base,
    tabsByWorktree: {
      [TEST_WORKTREE_ID]: [
        {
          ...base.tabsByWorktree[TEST_WORKTREE_ID]![0]!,
          ptyId: PTY,
          title: AGENT_AUTHORED_TITLE,
          defaultTitle: 'Terminal 1'
        }
      ]
    },
    terminalLayoutsByTabId: {
      'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: PTY })
    },
    terminalPtyIncarnationsByPaneKey: { [`host-tab:${HEADLESS_LEAF_ID}`]: incarnationId }
  }
}

const DURABLE_SURFACE = {
  worktreeId: TEST_WORKTREE_ID,
  tabId: 'host-tab',
  leafId: HEADLESS_LEAF_ID
}

function bindDurableSurface(
  runtime: AdmissionRuntime,
  incarnationId: string,
  admission?: unknown
): void {
  runtime.registerPty(
    PTY,
    TEST_WORKTREE_ID,
    null,
    { tabId: 'host-tab', leafId: HEADLESS_LEAF_ID, incarnationId },
    undefined,
    admission as never
  )
}

function durablyBoundPaneTitle(getSession: () => WorkspaceSessionState): string | undefined {
  return getSession().tabsByWorktree[TEST_WORKTREE_ID]?.find((tab) => tab.id === 'host-tab')?.title
}

function seedAgentAuthoredSurface(runtime: AdmissionRuntime, title: string): void {
  runtime['storeMobileSessionSnapshot'](TEST_WORKTREE_ID, {
    worktree: TEST_WORKTREE_ID,
    publicationEpoch: 'headless:test',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabGroups: [],
    tabs: [
      {
        type: 'terminal',
        id: `host-tab::${HEADLESS_LEAF_ID}`,
        parentTabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID,
        ptyId: PTY,
        title,
        isActive: false
      }
    ]
  })
}

/**
 * The durable known-old of a pane whose own exit removed the binding. This is the ordering a real
 * replacement takes: the exit retires the surface (tab, layout and incarnation all gone) while the
 * process is still alive, and the successor registers milliseconds later.
 */
describe('runtime PTY observation admission over a retired durable surface', () => {
  function retiredPredecessor(incarnationId = OLD): {
    runtime: AdmissionRuntime
    setSession: (next: WorkspaceSessionState) => void
    getSession: () => WorkspaceSessionState
    reconcileAgentStatusForEndedProcess: ReturnType<typeof vi.fn>
  } {
    const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(
      sessionWithDurablePredecessor(incarnationId)
    )
    const reconcileAgentStatusForEndedProcess = vi.fn()
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      reconcileAgentStatusForEndedProcess
    })
    runtime['retireMobileSessionSurfacesForPty'](PTY, incarnationId, [
      { worktreeId: TEST_WORKTREE_ID, parentTabId: 'host-tab', leafId: HEADLESS_LEAF_ID }
    ])
    // The successor's own binding persistence recreates the pane's durable rows before registerPty.
    setSession({
      ...sessionWithDurablePredecessor(NEW),
      terminalPtyIncarnationsByPaneKey: {}
    })
    seedAgentAuthoredSurface(runtime, AGENT_AUTHORED_TITLE)
    return { runtime, getSession, setSession, reconcileAgentStatusForEndedProcess }
  }

  it('keeps a proven predecessor as known-old after its exit removed the durable binding', () => {
    const { runtime, getSession } = retiredPredecessor()

    // The exit is what removed the durable identity, so the successor cannot read it back.
    expect(getSession().terminalPtyIncarnationsByPaneKey).toEqual({})
    expect(runtime['readKnownPredecessorPaneIncarnationForPty'](PTY, DURABLE_SURFACE)).toBe(OLD)
  })

  it('retires the predecessor surface on that known-old when the successor registers', () => {
    const { runtime, getSession, reconcileAgentStatusForEndedProcess } = retiredPredecessor()
    const token = runtime.beginPtyObservationAdmission(PTY)

    const prepared = runtime.preparePtyObservationAdmission(token, PTY, NEW, DURABLE_SURFACE)

    expect(prepared?.persistedIncarnationId).toBe(OLD)
    bindDurableSurface(runtime, NEW, prepared)
    // The stale durable row still carries the predecessor's live label; it must not survive.
    expect(durablyBoundPaneTitle(getSession)).toBe('Terminal 1')
    expect(reconcileAgentStatusForEndedProcess).toHaveBeenCalledWith(expect.anything(), {
      preserveResumeIdentity: true
    })
  })

  it('never reads another PTY retired record as this PTY predecessor', () => {
    const { runtime } = retiredPredecessor()

    expect(
      runtime['readKnownPredecessorPaneIncarnationForPty']('pty-successor', DURABLE_SURFACE)
    ).toBeNull()
  })

  it('keeps the same incarnation out of the replacement proof', () => {
    const { runtime, getSession, reconcileAgentStatusForEndedProcess } = retiredPredecessor()

    const token = runtime.beginPtyObservationAdmission(PTY)
    const prepared = runtime.preparePtyObservationAdmission(token, PTY, OLD, DURABLE_SURFACE)

    expect(prepared?.persistedIncarnationId).toBe(OLD)
    bindDurableSurface(runtime, OLD, prepared)
    // Same incarnation: nothing is replaced, so the predecessor's label stays.
    expect(durablyBoundPaneTitle(getSession)).toBe(AGENT_AUTHORED_TITLE)
    expect(reconcileAgentStatusForEndedProcess).not.toHaveBeenCalled()
  })

  it('keeps the replacement retirement out of an untagged successor registration', () => {
    const { runtime, reconcileAgentStatusForEndedProcess } = retiredPredecessor()

    // A registration that cannot name its incarnation has no known-new half of the proof.
    runtime.registerPty(PTY, TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })

    expect(reconcileAgentStatusForEndedProcess).not.toHaveBeenCalled()
  })

  it('prefers a still-durable binding over an older retired record', () => {
    const { runtime, setSession } = retiredPredecessor()
    setSession(sessionWithDurablePredecessor('incarnation-between'))

    expect(runtime['readKnownPredecessorPaneIncarnationForPty'](PTY, DURABLE_SURFACE)).toBe(
      'incarnation-between'
    )
  })

  it('forgets the retired record with the PTY that produced it', () => {
    const { runtime } = retiredPredecessor()

    runtime['disposePtyObservationState'](PTY)

    expect(runtime['readKnownPredecessorPaneIncarnationForPty'](PTY, DURABLE_SURFACE)).toBeNull()
  })
})
