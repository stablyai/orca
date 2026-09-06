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
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

const repoRoot = resolve(__dirname, '../../..')
const REAPER_MODULE = 'src/main/runtime/orca-runtime-on-pty-exit.ts'

/** `fooByPtyId`, plus the older `ById` spellings that are still keyed by pty id. */
const PTY_KEYED_FIELD = /(?:ByPtyId|Pty[A-Za-z]*ById)$/i

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
  'parkedMessageRedeliveriesByPtyId'
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
      ...SELF_CLEARING_IN_FLIGHT,
      ...Object.keys(INTENTIONALLY_RETAINED)
    ].filter((field) => !known.has(field))
    expect(stale, 'classified fields that no longer exist').toEqual([])
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
