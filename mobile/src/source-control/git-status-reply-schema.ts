import { z } from 'zod'
import { openEnum, salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'

// Schemas for the two `git.status` replies mobile reads. Checked against the host's published
// shape in src/shared/git-status-types.ts (GitStatusResult / GitUncommittedEntry), which is what
// src/main/runtime/rpc/methods/git.ts returns from getRuntimeGitStatus verbatim.
//
// A member is required only where a consumer reads it without a guard. Everything the host may
// send and mobile does not read is undeclared and passes through: a schema that required a field
// an older host omits would turn every reply from that host into an incompatible error.

const GIT_FILE_STATUS = ['modified', 'added', 'deleted', 'renamed', 'untracked', 'copied'] as const
const GIT_STAGING_AREA = ['staged', 'unstaged', 'untracked'] as const
const GIT_CONFLICT_STATUS = ['unresolved', 'resolved_locally'] as const
const GIT_CONFLICT_SOURCE = ['git', 'session'] as const
const GIT_CONFLICT_KIND = [
  'both_modified',
  'both_added',
  'both_deleted',
  'added_by_us',
  'added_by_them',
  'deleted_by_us',
  'deleted_by_them'
] as const
const GIT_CONFLICT_OPERATION = ['merge', 'rebase', 'cherry-pick', 'unknown'] as const

// Built once: readProjectedConflictOperation runs on every reply.
const gitConflictOperationSchema = z.enum(GIT_CONFLICT_OPERATION)

/**
 * One working-tree entry.
 *
 * `path`, `status` and `area` are required because every list read reaches them unguarded:
 * use-mobile-source-control-state.ts:122 sections by `entry.area`, mobile-git-status.ts:63 sorts on
 * `entry.path`, and MOBILE_GIT_STATUS_LABELS is indexed by `entry.status`. The rest are optional in
 * the host type and read through a guard or a default, so they stay optional here.
 *
 * `area` degrades to absent rather than to an arm. Every arm carries an affordance — stage,
 * unstage, commit — and every reader is an equality check against a known one, so an absent area
 * lands the row in no section and withholds all three, which is what main did with an area it did
 * not know. Dropping the row instead would also drop it from the unresolved-conflict gate, which
 * grants create on a conflicted worktree.
 */
const gitStatusEntrySchema = z.looseObject({
  path: z.string(),
  status: openEnum(GIT_FILE_STATUS, 'modified'),
  area: openEnum(GIT_STAGING_AREA, undefined),
  oldPath: z.string().optional(),
  conflictKind: openEnum(GIT_CONFLICT_KIND, undefined).optional(),
  conflictStatus: openEnum(GIT_CONFLICT_STATUS, undefined).optional(),
  conflictStatusSource: openEnum(GIT_CONFLICT_SOURCE, undefined).optional(),
  added: z.number().optional(),
  removed: z.number().optional()
})

const gitUpstreamStatusSchema = z.looseObject({
  hasUpstream: z.boolean(),
  ahead: z.number(),
  behind: z.number(),
  upstreamName: z.string().optional(),
  hasConfiguredPushTarget: z.boolean().optional(),
  behindCommitsArePatchEquivalent: z.boolean().optional()
})

/**
 * The verbatim host payload the Changes screen publishes into its ready state.
 *
 * Only `entries` is required: mobile-hosted-review-create-intent.ts:70 reads
 * `status?.entries.some(...)`, which throws on a status object without it. Every other consumer
 * optional-chains — MobileSourceControlPanel.tsx:126/274, use-mobile-source-control-state.ts:163.
 * A salvaging array so one unreadable row drops instead of failing the whole screen's reply, and
 * salvagedOptional so a malformed optional reads as absent rather than as an incompatible reply.
 */
export const gitStatusHostPayloadSchema = z.looseObject({
  entries: salvagingArray(gitStatusEntrySchema),
  conflictOperation: salvagedOptional('conflictOperation', gitConflictOperationSchema),
  branch: salvagedOptional('branch', z.string()),
  head: salvagedOptional('head', z.string()),
  upstreamStatus: salvagedOptional('upstreamStatus', gitUpstreamStatusSchema)
})

export type MobileGitStatusEntry = z.output<typeof gitStatusEntrySchema>
export type MobileGitStatusHostPayload = z.output<typeof gitStatusHostPayloadSchema>
export type MobileGitUpstreamStatus = z.output<typeof gitUpstreamStatusSchema>
type MobileProjectedUpstreamStatus = z.output<typeof projectedUpstreamStatusSchema>
type GitConflictOperation = (typeof GIT_CONFLICT_OPERATION)[number]

/** What readMobileGitStatusResult publishes: the host payload narrowed to five members. */
type MobileGitStatusProjection = {
  entries: MobileGitStatusEntry[]
  conflictOperation: GitConflictOperation
  branch: string | undefined
  head: string | undefined
  upstreamStatus: MobileProjectedUpstreamStatus | undefined
}

// The projection's own shapes: the fields readMobileGitStatusResult kept, nothing else, and every
// one of them written out even when absent. Not loose, and not zod's own optional-key omission —
// main built these objects by hand, so an absent member is a present `undefined`, which is what
// the recorded projections carry.
const projectedUpstreamStatusSchema = z
  .object({
    hasUpstream: z.boolean(),
    ahead: z.number().finite(),
    behind: z.number().finite(),
    upstreamName: salvagedOptional('upstreamName', z.string()),
    hasConfiguredPushTarget: salvagedOptional('hasConfiguredPushTarget', z.boolean()),
    behindCommitsArePatchEquivalent: salvagedOptional(
      'behindCommitsArePatchEquivalent',
      z.boolean()
    )
  })
  .transform((value) => ({
    hasUpstream: value.hasUpstream,
    upstreamName: value.upstreamName,
    ahead: value.ahead,
    behind: value.behind,
    hasConfiguredPushTarget: value.hasConfiguredPushTarget,
    behindCommitsArePatchEquivalent: value.behindCommitsArePatchEquivalent
  }))

const projectedEntrySchema = z.object({
  // `.min(1)` because main's `!path` drop is falsy, not nullish: an empty path was never a row.
  path: z.string().min(1),
  status: openEnum(GIT_FILE_STATUS, 'modified'),
  area: openEnum(GIT_STAGING_AREA, undefined),
  oldPath: salvagedOptional('oldPath', z.string()),
  conflictStatus: salvagedOptional('conflictStatus', z.enum(GIT_CONFLICT_STATUS)),
  conflictStatusSource: salvagedOptional('conflictStatusSource', z.enum(GIT_CONFLICT_SOURCE)),
  added: salvagedOptional('added', z.number().finite()),
  removed: salvagedOptional('removed', z.number().finite())
})

/**
 * The normalized projection hosted-review preparation and the diff-review loaders read.
 *
 * `.catch(null)` keeps this reader's verdict exactly where main put it: a payload that is not a
 * record, or whose `entries` is not an array, is a decoded `null`, not an incompatible reply.
 * Three call sites route on that null — a refused status must leave their screens alone — so
 * tightening it is a product decision with its own expectation, not part of this step.
 */
export const gitStatusProjectionSchema: z.ZodType<MobileGitStatusProjection | null, unknown> = z
  .object({
    entries: salvagingArray(projectedEntrySchema),
    conflictOperation: z.unknown().optional(),
    branch: salvagedOptional('branch', z.string()),
    head: salvagedOptional('head', z.string()),
    upstreamStatus: salvagedOptional('upstreamStatus', projectedUpstreamStatusSchema)
  })
  .transform((value): MobileGitStatusProjection => ({
    entries: value.entries.map((entry) => ({
      path: entry.path,
      status: entry.status,
      area: entry.area,
      oldPath: entry.oldPath,
      // Never projected: main dropped the host's conflictKind and stamped undefined instead.
      conflictKind: undefined,
      conflictStatus: entry.conflictStatus,
      conflictStatusSource: entry.conflictStatusSource,
      added: entry.added,
      removed: entry.removed
    })),
    conflictOperation: readProjectedConflictOperation(value.conflictOperation),
    branch: value.branch,
    head: value.head,
    upstreamStatus: value.upstreamStatus
  }))
  .nullable()
  .catch(null)

// Main coerced an unreadable operation to 'unknown' rather than dropping the reply; four screens
// render off that value, so the coercion is the behaviour, not a defect.
function readProjectedConflictOperation(value: unknown): GitConflictOperation {
  const parsed = gitConflictOperationSchema.safeParse(value)
  return parsed.success ? parsed.data : 'unknown'
}
