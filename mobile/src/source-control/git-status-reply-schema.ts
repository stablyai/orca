import { z } from 'zod'
import { openEnum, salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'

// Require only unguarded consumer fields; unread host metadata must not become a compatibility gate.

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

const gitConflictOperationSchema = z.enum(GIT_CONFLICT_OPERATION)

// Unknown area withholds stage/unstage/commit, but retain the row for unresolved-conflict gating.
// Path and status are read unguarded; other fields have consumer fallbacks.
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

// Only entries is read unguarded; salvage malformed rows and optional fields instead of failing the screen.
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

type MobileGitStatusProjection = {
  entries: MobileGitStatusEntry[]
  conflictOperation: GitConflictOperation
  branch: string | undefined
  head: string | undefined
  upstreamStatus: MobileProjectedUpstreamStatus | undefined
}

// Preserve projected keys with undefined values; optional-key omission changes the established projection.
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
  // Empty paths were never valid projected rows.
  path: z.string().min(1),
  status: openEnum(GIT_FILE_STATUS, 'modified'),
  area: openEnum(GIT_STAGING_AREA, undefined),
  oldPath: salvagedOptional('oldPath', z.string()),
  conflictStatus: salvagedOptional('conflictStatus', z.enum(GIT_CONFLICT_STATUS)),
  conflictStatusSource: salvagedOptional('conflictStatusSource', z.enum(GIT_CONFLICT_SOURCE)),
  added: salvagedOptional('added', z.number().finite()),
  removed: salvagedOptional('removed', z.number().finite())
})

// Unreadable normalized status is null; callers fall back on that verdict instead of rejecting the reply.
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
      // Preserve the established projection: conflictKind is always undefined.
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

// Unrecognized conflict operations render as unknown instead of rejecting the reply.
function readProjectedConflictOperation(value: unknown): GitConflictOperation {
  const parsed = gitConflictOperationSchema.safeParse(value)
  return parsed.success ? parsed.data : 'unknown'
}
