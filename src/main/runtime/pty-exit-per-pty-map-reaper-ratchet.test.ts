/**
 * Ratchet: `onPtyExit` is the reaper for per-PTY runtime state, and every
 * per-PTY-keyed collection on the runtime must be accounted for there.
 *
 * `ptyLifecycleGenerationById` was added next to ~25 siblings the reaper already
 * deleted — including `agentPromptExplicitStatusFloorByPtyId`, set two lines below
 * it in `advancePtyLifecycleGeneration` — and was simply never added to the list.
 * Nothing failed, so it accumulated one number per PTY for the life of the process.
 * A hand-maintained delete list has no way to notice the next omission; this does.
 *
 * The field list is read off a real instance rather than parsed out of the source,
 * so a map declared in any of the ~90 mixin files is covered the moment it exists.
 * Every field must land in exactly one bucket, and the two "cleaned elsewhere"
 * buckets are verified against real source rather than trusted as an allowlist.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { MAX_RETIRED_PTY_PANES } from './runtime-pty-replacement-durable-retirement'
import { TEST_WORKTREE_ID } from './orca-runtime-test-fixtures.spec'

const repoRoot = resolve(__dirname, '../../..')
const REAPER_MODULE = 'src/main/runtime/orca-runtime-on-pty-exit.ts'
const PTY_REPLACEMENT_RETIREMENT_MODULE =
  'src/main/runtime/runtime-pty-replacement-durable-retirement.ts'

/** `fooByPtyId`, plus the older `ById` spellings that are still keyed by pty id. */
const PTY_KEYED_FIELD = /(?:ByPtyId|Pty[A-Za-z]*ById|ByPaneKey)$/i

/**
 * Collections keyed by pane rather than by PTY: the pane outlives the PTY whose exit creates the
 * entry, so the reaper above cannot own them. Each entry names the module that declares it and the
 * release a successor consumes it through; a `boundedBy` record must also carry that bound in real
 * source, because a pane that is closed instead of respawned has no later event to release it. The
 * release itself is exercised against a real runtime below, not trusted from the names.
 */
const PANE_KEYED_RELEASED: Record<
  string,
  { module: string; releasedBy: string; boundedBy?: string }
> = {
  retiredPtyIncarnationByPaneKey: {
    module: PTY_REPLACEMENT_RETIREMENT_MODULE,
    // Consumed by the successor registration that persisted the pane's new binding.
    releasedBy: 'this.retiredPtyIncarnationByPaneKey.delete(paneKey)',
    boundedBy: 'this.retiredPtyIncarnationByPaneKey.size > MAX_RETIRED_PTY_PANES'
  },
  retiredPaneEvidenceByPaneKey: {
    module: PTY_REPLACEMENT_RETIREMENT_MODULE,
    // Released with the successor PTY the record is scoped to, by the reaper's own helper.
    releasedBy: 'this.retiredPaneEvidenceByPaneKey.delete(paneKey)',
    // One record per pane, and its successor supersedes or releases it: a later proven
    // replacement overwrites the pane's record, and the successor's own certified disposal runs
    // the delete above. An unconfirmed SSH exit deliberately skips that release (the successor
    // may still own the pane), so the successor PTY's later certified death or prune is the bound.
    boundedBy: 'evidence.successorPtyId === ptyId'
  }
}

/** Cleared by a helper the reaper calls; the helper is verified below, not trusted. */
const CLEARED_BY_REAPER_HELPER: Record<string, { helper: string; module: string }> = {
  waitBlockedCheckStateByPtyId: {
    helper: 'clearWaitBlockedCheckState',
    module: 'src/main/runtime/orca-runtime-schedule-wait-blocked-check.ts'
  },
  ptyTitleTrackersByPtyId: {
    helper: 'disposePtyTitleTracker',
    module: 'src/main/runtime/orca-runtime-apply-tracked-pty-title.ts'
  },
  agentPromptLifecycleByPtyId: {
    helper: 'advancePtyLifecycleGeneration',
    module: 'src/main/runtime/orca-runtime-record-agent-prompt-lifecycle-state.ts'
  },
  agentPromptPermissionSequenceByPtyId: {
    helper: 'advancePtyLifecycleGeneration',
    module: 'src/main/runtime/orca-runtime-record-agent-prompt-lifecycle-state.ts'
  },
  ptyObservationCapsulesByPtyId: {
    helper: 'disposePtyObservationState',
    module: 'src/main/runtime/orca-runtime-pty-observation-admission.ts'
  },
  admittedPtyObservationSourceByPtyId: {
    helper: 'disposePtyObservationState',
    module: 'src/main/runtime/orca-runtime-pty-observation-admission.ts'
  },
  retiredRestoreSeedIncarnationByPtyId: {
    helper: 'disposePtyObservationState',
    module: 'src/main/runtime/orca-runtime-pty-observation-admission.ts'
  }
}

/**
 * One entry per in-flight operation, removed by that operation's own settle path.
 * Bounded by concurrency, not by how many PTYs the session has ever had, so the
 * reaper deleting them would race the settle rather than reclaim anything.
 */
const SELF_CLEARING_IN_FLIGHT = new Set([
  'providerVisibleStateReadsByPtyId',
  'agentPromptSubmissionTailByPtyId',
  'interactiveWaitProbesByPtyId',
  'orchestrationPointerAdmissionByPtyId',
  'messageDeliveryFlightsByPtyId',
  'parkedMessageRedeliveriesByPtyId',
  // One entry per in-flight spawn, settled by that spawn's own accept/cancel path.
  // Reaping it on exit would cancel a replacement spawn's admission mid-flight.
  // Its by-token sibling (pendingPtyObservationAdmissionsByToken) is keyed by
  // operation, not PTY, so it is outside this scan; it is deleted on every settle
  // path — accept, cancel, and a contested transfer whose canonical id already has
  // an owner (pty-observation-admission.spec.ts asserts that last one).
  'pendingPtyObservationAdmissionTokensByPtyId'
])

/** Outlives the exit on purpose; each is reaped by its own later teardown. */
const INTENTIONALLY_RETAINED: Record<string, string> = {
  ptysById:
    'the record carries lastExitCode/lastExitCause for `ps` and reconnect; pruneDisconnectedPtyRecords owns it',
  leavesByPtyId:
    'rebuilt from the renderer graph by rebuildLeafPtyIndex; the leaf shows the exit state until tab teardown',
  handleByPtyId:
    'the terminal handle stays addressable after exit; invalidateAllHandlesForPty retires it',
  ptyLivenessVerdictByPtyId:
    'an unverifiable SSH surface must keep its verdict across the exit; cleared on respawn and on a certified death'
}

function ptyKeyedFieldNames(): string[] {
  const runtime = new OrcaRuntimeService() as unknown as Record<string, unknown>
  return Object.keys(runtime).filter((key) => {
    const value = runtime[key]
    return PTY_KEYED_FIELD.test(key) && (value instanceof Map || value instanceof Set)
  })
}

/** Comments are stripped so a commented-out delete cannot satisfy the ratchet. */
function readModule(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('onPtyExit per-PTY map reaper coverage', () => {
  const fields = ptyKeyedFieldNames()
  const reaperSource = readModule(REAPER_MODULE)

  it('does not accept a commented-out delete as coverage', () => {
    // The first draft of this ratchet passed against a tree where the fix was
    // commented out, because the comment still contained the call text.
    expect(readModule(REAPER_MODULE)).not.toContain('Safe against respawn')
    expect(reaperSource).toContain('this.ptyLifecycleGenerationById.delete(ptyId)')
  })

  it('finds the per-PTY fields it claims to scan', () => {
    // Guards the detector itself: a rename that breaks the regex would otherwise
    // make this whole file pass by scanning nothing.
    expect(fields.length).toBeGreaterThan(30)
    expect(fields).toContain('ptyLifecycleGenerationById')
    expect(fields).toContain('agentPromptExplicitStatusFloorByPtyId')
  })

  it('accounts for every per-PTY-keyed collection on the runtime', () => {
    const unaccounted = fields.filter(
      (field) =>
        !reaperSource.includes(`this.${field}.delete(ptyId)`) &&
        !(field in CLEARED_BY_REAPER_HELPER) &&
        !(field in PANE_KEYED_RELEASED) &&
        !SELF_CLEARING_IN_FLIGHT.has(field) &&
        !(field in INTENTIONALLY_RETAINED)
    )
    expect(
      unaccounted,
      `${REAPER_MODULE} must delete these per-PTY entries, or they must be classified in this test`
    ).toEqual([])
  })

  it('keeps every classification about a field that still exists', () => {
    const known = new Set(fields)
    const stale = [
      ...Object.keys(CLEARED_BY_REAPER_HELPER),
      ...Object.keys(PANE_KEYED_RELEASED),
      ...SELF_CLEARING_IN_FLIGHT,
      ...Object.keys(INTENTIONALLY_RETAINED)
    ].filter((field) => !known.has(field))
    expect(stale, 'classified fields that no longer exist').toEqual([])
  })

  it('verifies each pane-keyed release against the module that declares it', () => {
    for (const [field, { module, releasedBy, boundedBy }] of Object.entries(PANE_KEYED_RELEASED)) {
      const source = readModule(module)
      expect(source, `${module} must declare ${field}`).toContain(`${field} = new Map`)
      expect(source, `${field} must be released by ${module}`).toContain(releasedBy)
      if (boundedBy) {
        expect(source, `${field} must carry its declared bound in ${module}`).toContain(boundedBy)
      }
    }
  })

  it('leaves no pane-keyed field unclassified and none double-counted', () => {
    // The two buckets must stay disjoint: a pane-keyed field can never be reaped by `ptyId`.
    for (const field of Object.keys(PANE_KEYED_RELEASED)) {
      expect(field.endsWith('ByPaneKey'), `${field} is not a pane-keyed spelling`).toBe(true)
      expect(reaperSource.includes(`this.${field}.delete(ptyId)`)).toBe(false)
    }
  })

  it('verifies each helper is called by the reaper and deletes the field it is credited with', () => {
    for (const [field, { helper, module }] of Object.entries(CLEARED_BY_REAPER_HELPER)) {
      expect(reaperSource, `${REAPER_MODULE} must call ${helper}`).toContain(
        `this.${helper}(ptyId)`
      )
      expect(readModule(module), `${helper} must delete ${field}`).toContain(
        `this.${field}.delete(ptyId)`
      )
    }
  })
})

describe('pane-keyed replacement record retention (leak regression)', () => {
  type RetirementMaps = {
    retiredPtyIncarnationByPaneKey: Map<string, { ptyId: string }>
    retiredPaneEvidenceByPaneKey: Map<string, { successorPtyId: string }>
  }

  const PTY = 'pty-retirement-reaped'
  const OLD_INCARNATION = 'incarnation-predecessor'
  const NEW_INCARNATION = 'incarnation-successor'
  const TAB_ID = 'tab-retirement-reaped'
  const LEAF_ID = '11111111-2222-4333-8444-555555555555'
  const SURFACE = { worktreeId: TEST_WORKTREE_ID, tabId: TAB_ID, leafId: LEAF_ID }

  /** The identity-only shape the hook server retains on this retirement path. */
  function retiredRow(): AgentStatusIpcPayload {
    return {
      paneKey: makePaneKey(TAB_ID, LEAF_ID),
      state: 'idle',
      prompt: '',
      agentType: 'pi',
      connectionId: null,
      receivedAt: 1,
      stateStartedAt: 1
    } as unknown as AgentStatusIpcPayload
  }

  /** The durable known-old of a pane whose own exit removed the binding, and its retired row. */
  function retiredPaneRuntime(): OrcaRuntimeService {
    const runtime = new OrcaRuntimeService(null, undefined, {
      getAgentProviderSessionRowsForPane: () => [retiredRow()],
      reconcileAgentStatusForEndedProcess: vi.fn()
    })
    runtime['retireMobileSessionSurfacesForPty'](PTY, OLD_INCARNATION, [
      { worktreeId: SURFACE.worktreeId, parentTabId: SURFACE.tabId, leafId: SURFACE.leafId }
    ])
    return runtime
  }

  function retirementMaps(runtime: OrcaRuntimeService): RetirementMaps {
    return runtime as unknown as RetirementMaps
  }

  function registerSuccessor(runtime: OrcaRuntimeService): void {
    const token = runtime.beginPtyObservationAdmission(PTY)
    const prepared = runtime.preparePtyObservationAdmission(token, PTY, NEW_INCARNATION, SURFACE)
    runtime.registerPty(
      PTY,
      TEST_WORKTREE_ID,
      null,
      { tabId: TAB_ID, leafId: LEAF_ID, incarnationId: NEW_INCARNATION },
      undefined,
      prepared
    )
  }

  it('consumes the pane known-old once the successor registration persisted the binding', () => {
    const runtime = retiredPaneRuntime()
    expect(retirementMaps(runtime).retiredPtyIncarnationByPaneKey.size).toBe(1)

    registerSuccessor(runtime)

    // The record existed only until the successor's own durable binding could carry known-old.
    expect(retirementMaps(runtime).retiredPtyIncarnationByPaneKey.size).toBe(0)
  })

  it('releases the retired row evidence with the successor PTY that proved the replacement', () => {
    const runtime = retiredPaneRuntime()

    registerSuccessor(runtime)
    expect(retirementMaps(runtime).retiredPaneEvidenceByPaneKey.size).toBe(1)

    runtime.onPtyExit(PTY, 0)

    // The successor's own teardown is the only thing that can release it: no later event will.
    expect(retirementMaps(runtime).retiredPaneEvidenceByPaneKey.size).toBe(0)
  })

  it('releases the retired row evidence when a disconnected successor record is pruned', () => {
    const runtime = retiredPaneRuntime()

    registerSuccessor(runtime)
    expect(retirementMaps(runtime).retiredPaneEvidenceByPaneKey.size).toBe(1)

    // Pruning removes the record without the exit callback, so it must run the same release or
    // the evidence map keeps one entry per pane this session ever replaced.
    const internals = runtime as unknown as {
      dropDisconnectedPtyRecord: (ptyId: string) => void
    }
    internals.dropDisconnectedPtyRecord(PTY)

    expect(retirementMaps(runtime).retiredPaneEvidenceByPaneKey.size).toBe(0)
  })

  it('bounds the panes whose successor never arrives', () => {
    const runtime = retiredPaneRuntime()

    for (let index = 0; index < MAX_RETIRED_PTY_PANES + 20; index += 1) {
      runtime['retireMobileSessionSurfacesForPty'](`pty-${index}`, `incarnation-${index}`, [
        { worktreeId: TEST_WORKTREE_ID, parentTabId: `tab-${index}`, leafId: LEAF_ID }
      ])
    }

    expect(retirementMaps(runtime).retiredPtyIncarnationByPaneKey.size).toBe(MAX_RETIRED_PTY_PANES)
    // The first pane's record is the oldest, so the bound evicted it first.
    expect(
      [...retirementMaps(runtime).retiredPtyIncarnationByPaneKey.values()].some(
        (entry) => entry.ptyId === PTY
      )
    ).toBe(false)
  })
})

describe('per-PTY lifecycle generation retention (leak regression)', () => {
  type Internals = { ptyLifecycleGenerationById: Map<string, number> }

  it('retains no lifecycle generation after a spawn/exit cycle', () => {
    const runtime = new OrcaRuntimeService()
    const internals = runtime as unknown as Internals
    for (let index = 0; index < 50; index += 1) {
      const ptyId = `pty-${index}`
      runtime.onPtySpawned(ptyId)
      runtime.onPtyExit(ptyId, 0)
    }
    expect(internals.ptyLifecycleGenerationById.size).toBe(0)
  })

  it('never hands a respawn a generation a pre-exit capture could still match', () => {
    const runtime = new OrcaRuntimeService()
    const internals = runtime as unknown as Internals & {
      getPtyLifecycleGeneration: (ptyId: string) => number
    }
    runtime.onPtySpawned('pty-1')
    const beforeExit = internals.getPtyLifecycleGeneration('pty-1')
    runtime.onPtyExit('pty-1', 0)

    runtime.onPtySpawned('pty-1')
    const afterRespawn = internals.getPtyLifecycleGeneration('pty-1')

    expect(afterRespawn).toBeGreaterThan(beforeExit)
    // Stable once re-minted, so a post-respawn capture keeps matching itself.
    expect(internals.getPtyLifecycleGeneration('pty-1')).toBe(afterRespawn)
  })
})
