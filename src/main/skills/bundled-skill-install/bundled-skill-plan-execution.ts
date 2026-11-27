import type {
  BundledSkillInstallResult,
  BundledSkillOp,
  BundledSkillOpOutcome,
  BundledSkillOutcome,
  BundledSkillPlanEntry
} from '../../../shared/skills/bundled/bundled-skill-plan'
import {
  holdsCurrentBundledSkillCopy,
  isBundledSkillAutoUpdateOp
} from '../../../shared/skills/bundled/bundled-skill-summary'
import { bundledSkillOpBackupPaths } from '../../../shared/skills/bundled/bundled-skill-backup-refusal'
import { applyOp, type AppliedOp, type SkillRun } from './bundled-skill-op-application'
import { buildBundledSkillPlan, type BundledSkillPlanInput } from './bundled-skill-plan'
import { findBundledSkillSource } from './bundled-skill-source-selection'
import { withBundledSkillTargetLocks } from './bundled-skill-target-locks'
import { recordBundledSkillDigestWritten } from './bundled-skill-written-digests'

export type BundledSkillExecuteInput = BundledSkillPlanInput & {
  /** Per-lock wait; the shared 5s default applies when unset. */
  lockTimeoutMs?: number
}

/** Applies one skill's ops in order, then records its marker if this build's bytes are on disk. */
async function runSkill(run: SkillRun): Promise<BundledSkillOutcome> {
  const statuses = new Map<string, BundledSkillOpOutcome['status']>()
  const verified = new Set<string>()
  const ops: BundledSkillOpOutcome[] = []
  for (const op of run.entry.ops) {
    const applied: AppliedOp =
      op.requires && statuses.get(op.requires) !== 'done'
        ? {
            outcome: { path: op.path, kind: op.kind, status: 'skipped' },
            verified: false,
            satisfiesDependents: false
          }
        : await applyOp(run, op)
    const { outcome } = applied
    statuses.set(op.path, applied.satisfiesDependents ? 'done' : outcome.status)
    if (applied.verified) {
      verified.add(op.path)
    }
    ops.push(outcome)
  }
  // Only bytes checked on disk during this run count: a planned current copy may have changed.
  if (
    run.entry.ops.some(
      (op) =>
        verified.has(op.path) &&
        (op.content === 'files' ||
          (op.kind === 'keep' &&
            op.observed.kind === 'folder' &&
            op.observed.skillDigest === run.entry.digest))
    )
  ) {
    await recordOrcaCopy(run.input, run.entry)
  }
  return { name: run.entry.name, status: 'ran', ops }
}

/**
 * Lets other Orca builds on this host recognise these bytes as Orca's, not a user edit.
 * Execution only: preview stays read-only.
 */
function recordOrcaCopy(input: BundledSkillPlanInput, entry: BundledSkillPlanEntry) {
  return recordBundledSkillDigestWritten(
    input.filesystem,
    input.destination.homeDirectory,
    entry.name,
    entry.digest
  )
}

/** Re-plan under all target locks and require the previewed digest; stale previews must write nothing. */
export async function executeBundledSkillPlan(
  input: BundledSkillExecuteInput,
  planDigest: string
): Promise<BundledSkillInstallResult> {
  const names = input.names ?? input.sources.map((source) => source.name)
  const unrun = (status: 'changed' | 'busy'): BundledSkillInstallResult => ({
    scope: input.destination.scope,
    skills: names.map((name) => ({ name, status, ops: [] }))
  })
  return withBundledSkillTargetLocks(input, unrun, async () => {
    const { plan } = await buildBundledSkillPlan(input)
    if (plan.planDigest !== planDigest) {
      return unrun('changed')
    }
    const skills: BundledSkillOutcome[] = []
    for (const entry of plan.skills) {
      skills.push(
        await runSkill({
          input,
          entry,
          source: findBundledSkillSource(input.sources, entry.name)
        })
      )
    }
    return { scope: plan.scope, skills }
  })
}

/**
 * Places this run found no longer as planned, judged per placement rather than by the op's own
 * status: an op that did not finish (unless its own copy was rechecked as current) disproves its
 * own place, and any op whose retirement did not simply remove a verified old copy (it failed, was
 * refused, or backed up an edit made after planning) disproves each retired place. No payload is
 * read to decide this.
 */
function disprovedPlacements(
  ops: readonly BundledSkillOp[],
  ran: BundledSkillOutcome | undefined
): Set<string> {
  const stale = new Set<string>()
  for (const outcome of ran?.ops ?? []) {
    if (outcome.status !== 'done' && !outcome.currentConfirmed) {
      stale.add(outcome.path)
    }
    const retirementClean =
      outcome.status === 'done' &&
      !outcome.backupRefusal &&
      bundledSkillOpBackupPaths(outcome).length === 0
    if (!retirementClean) {
      for (const previous of ops.find((op) => op.path === outcome.path)?.previous ?? []) {
        stale.add(previous.path)
      }
    }
  }
  return stale
}

/**
 * Plans each named installed skill under its locks and applies only hash-verified released-copy
 * updates; edited, foreign or interrupted locations are never touched. Each write re-checks its
 * location, and one skill's failure leaves the others' outcomes intact. `recordOnly` skips every
 * update and only records copies that already hold this build's bytes.
 */
export async function autoUpdateBundledSkills(
  input: BundledSkillExecuteInput & {
    names: readonly string[]
    recordOnly?: boolean
  }
): Promise<BundledSkillInstallResult> {
  const unrun = (status: 'changed' | 'busy'): BundledSkillInstallResult => ({
    scope: input.destination.scope,
    skills: input.names.map((name) => ({ name, status, ops: [] }))
  })
  return withBundledSkillTargetLocks(input, unrun, async () => {
    const { plan } = await buildBundledSkillPlan({
      ...input,
      installedOnly: true
    })
    const skills: BundledSkillOutcome[] = []
    for (const entry of plan.skills) {
      const safe = entry.ops.filter(isBundledSkillAutoUpdateOp)
      const required = new Set(safe.flatMap((op) => (op.requires ? [op.requires] : [])))
      const ops = entry.ops.filter(
        (op) =>
          safe.includes(op) ||
          (required.has(op.path) &&
            (op.kind === 'keep' || (op.kind === 'leave' && op.reason === 'other-build')) &&
            op.cleanup.every((item) => item.action === 'delete'))
      )
      let ran: BundledSkillOutcome | undefined
      if (ops.length > 0 && !input.recordOnly) {
        const source = findBundledSkillSource(input.sources, entry.name)
        ran = await runSkill({ input, entry: { ...entry, ops }, source })
        skills.push(ran)
      }
      // An already-current copy (keep-only, so nothing ran) written before markers existed. The
      // locked plan's observation of a place no longer counts once this run disproved it.
      const stale = disprovedPlacements(ops, ran)
      const fresh = { ...entry, ops: entry.ops.filter((op) => !stale.has(op.path)) }
      if (holdsCurrentBundledSkillCopy(fresh)) {
        await recordOrcaCopy(input, entry)
      }
    }
    return { scope: plan.scope, skills }
  })
}
