// Text for `orca skills install|update` plans and results.
import type {
  BundledSkillOp,
  BundledSkillOpOutcome,
  BundledSkillPlan
} from '../../shared/skills/bundled/bundled-skill-plan'
import { isBundledSkillLeaveReason } from '../../shared/skills/bundled/bundled-skill-plan'
import {
  bundledSkillOpBackupPaths,
  bundledSkillOpRefusalNotice,
  type BundledSkillRefusalNotice
} from '../../shared/skills/bundled/bundled-skill-backup-refusal'
import {
  BUNDLED_SKILL_LEAVE_REASON_TEXT,
  BUNDLED_SKILL_PLAN_OP_TEXT
} from '../../shared/skills/bundled/bundled-skill-summary'

function leaveText(reason: string | undefined): string {
  const text =
    reason && isBundledSkillLeaveReason(reason)
      ? BUNDLED_SKILL_LEAVE_REASON_TEXT[reason]
      : 'This copy was kept as it is'
  return `Update skipped: ${text}`
}

function describePlanOp(op: BundledSkillOp): string {
  return op.kind === 'leave' ? leaveText(op.reason) : BUNDLED_SKILL_PLAN_OP_TEXT[op.kind]
}

function describeRefusal(notice: BundledSkillRefusalNotice, backupFolder: string): string {
  const cannot = `Can't back it up to ${backupFolder}: it's on another drive.`
  switch (notice.source) {
    case 'in-place':
      // A retired copy put back in place may never be planned again, so a rerun won't find it.
      return notice.offeredAgain
        ? `${notice.skill}: kept as is at ${notice.path}. ${cannot} Move it out of the skills folder, then run again.`
        : `${notice.skill}: old copy kept as is at ${notice.path}. ${cannot} Move it out of the skills folder. Orca won't remind you.`
    case 'leftover':
      return `${notice.skill}: left-over copy kept at ${notice.path}. ${cannot} Move it out of the skills folder, then run again.`
    case 'moved-aside':
      // What the op published, if anything, is its own line above.
      return [
        `${notice.skill}: Old copy moved aside to ${notice.path}. ${cannot} Move it out of the skills folder to keep it.`,
        ...(notice.offeredAgain ? [] : ["Orca won't mention this copy again."])
      ].join(' ')
  }
}

const PUBLISHED_TEXT: Partial<Record<BundledSkillOpOutcome['kind'], string>> = {
  write: 'Installed.',
  copy: 'Installed.',
  link: 'Linked.',
  update: 'Updated.',
  replace: 'Updated.'
}

function describeOutcomeOp(op: BundledSkillOpOutcome, listPublished: boolean): string | null {
  switch (op.status) {
    case 'done':
      if (op.kind === 'leave') {
        return leaveText(op.reason)
      }
      return listPublished ? (PUBLISHED_TEXT[op.kind] ?? null) : null
    case 'changed':
      if (op.contentApplied) {
        return 'Partly done, then changed since it was planned. Run it again to re-plan.'
      }
      // An earlier cleanup in the op may already have moved an old copy (listed below).
      return bundledSkillOpBackupPaths(op).length > 0
        ? 'Changed since it was planned; no new copy was written. Run it again to re-plan.'
        : 'Changed since it was planned; nothing was written. Run it again to re-plan.'
    case 'skipped':
      return 'Skipped: the shared copy it depends on did not land.'
    case 'failed': {
      // A later step can fail after the new copy landed; name the copy before the failure.
      const published = op.contentApplied && listPublished ? PUBLISHED_TEXT[op.kind] : undefined
      return `${published ? `${published} Failed afterward` : 'Failed'}: ${op.error ?? 'unknown error'}`
    }
  }
}

/**
 * `listPublished`: the skill's summary line says "Needs attention", so name each location that
 * did get new content rather than let one refusal hide it.
 */
export function describeOutcomeOpLines(
  skill: string,
  op: BundledSkillOpOutcome,
  backupFolder: string,
  listPublished = false
): string[] {
  const refusal = bundledSkillOpRefusalNotice(skill, op)
  // An op can publish at its own path and then have a different, retired copy refused: name both.
  const published =
    refusal && op.contentApplied && refusal.path !== op.path ? PUBLISHED_TEXT[op.kind] : undefined
  const text = refusal ? (published ?? null) : describeOutcomeOp(op, listPublished)
  return [
    ...(text ? [`  ${op.path}: ${text}`] : []),
    ...(refusal ? [`  ${describeRefusal(refusal, backupFolder)}`] : []),
    ...bundledSkillOpBackupPaths(op).map((path) => `  ${op.path}: Old copy moved to ${path}`)
  ]
}

export function hasReplaceableLeave(plan: BundledSkillPlan): boolean {
  return plan.skills.some((entry) =>
    entry.ops.some((op) => op.kind === 'leave' && op.replaceable === true)
  )
}

export function describePlan(plan: BundledSkillPlan): string[] {
  return plan.skills.flatMap((entry) => [
    entry.name,
    ...entry.ops.map((op) => `  ${op.path}: ${describePlanOp(op)}`)
  ])
}
