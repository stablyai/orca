import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'
import {
  MERGEABLE_STATE,
  prCount,
  prNullableText,
  prStringList,
  prText
} from '../session/github-pr-entity-reply-schema'
import {
  assignableUserListSchema,
  detailCheckListSchema,
  detailCommentListSchema,
  detailFileListSchema,
  reviewSummaryListSchema
} from './task-provider-entity-reply-schema'

// Consumers default every field; preserve reviewDecision null for their own row-fallback policy.
export const githubWorkItemDetailSchema = z
  .looseObject({
    body: prText('body'),
    comments: salvagedOptional('comments', detailCommentListSchema),
    item: salvagedOptional(
      'item',
      z.looseObject({
        labels: prStringList('labels'),
        reviewDecision: prNullableText('reviewDecision'),
        reviewRequests: salvagedOptional('reviewRequests', assignableUserListSchema),
        latestReviews: salvagedOptional('latestReviews', reviewSummaryListSchema)
      })
    ),
    assignees: prStringList('assignees'),
    headSha: prText('headSha'),
    baseSha: prText('baseSha'),
    pullRequestId: prText('pullRequestId'),
    checks: salvagedOptional('checks', detailCheckListSchema),
    files: salvagedOptional('files', detailFileListSchema)
  })
  .nullable()

// Unknown mergeable values become absent so no unsupported host state changes merge affordances.
export const gitlabWorkItemDetailSchema = z
  .looseObject({
    body: prText('body'),
    comments: salvagedOptional('comments', detailCommentListSchema),
    item: salvagedOptional(
      'item',
      z.looseObject({
        labels: prStringList('labels'),
        mergeable: salvagedOptional('mergeable', z.enum(MERGEABLE_STATE))
      })
    ),
    assignees: prStringList('assignees'),
    pipelineJobs: salvagedOptional(
      'pipelineJobs',
      salvagingArray(
        z.looseObject({
          id: prCount('id'),
          name: z.string(),
          stage: z.string(),
          status: z.string(),
          webUrl: prNullableText('webUrl'),
          duration: salvagedOptional('duration', z.number().finite().nullable())
        })
      )
    ),
    reviewers: salvagedOptional('reviewers', z.array(z.unknown())),
    approvalState: salvagedOptional(
      'approvalState',
      z.looseObject({
        approvalsRequired: z.number().finite().nullable(),
        approvalsLeft: z.number().finite().nullable()
      })
    )
  })
  .nullable()

// Linear mapping reads identity, team and state unguarded; share this row schema with search/list.
// Preserve null estimate as no estimate, distinct from a host that did not report it.
export const linearIssueRowSchema = z.looseObject({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  updatedAt: z.string(),
  priority: z.number().finite(),
  labels: salvagingArray(z.string()),
  state: z.looseObject({ name: z.string(), type: z.string(), color: z.string() }),
  team: z.looseObject({ id: z.string(), name: z.string(), key: z.string() }),
  workspaceId: prText('workspaceId'),
  workspaceName: prText('workspaceName'),
  description: prText('description'),
  labelIds: prStringList('labelIds'),
  estimate: salvagedOptional('estimate', z.number().finite().nullable()),
  assignee: salvagedOptional(
    'assignee',
    z.looseObject({ id: prText('id'), displayName: z.string() })
  ),
  project: salvagedOptional(
    'project',
    z.looseObject({
      id: z.string(),
      name: z.string(),
      url: prText('url'),
      color: prText('color')
    })
  ),
  subIssues: salvagedOptional(
    'subIssues',
    salvagingArray(
      z.looseObject({
        id: z.string(),
        identifier: z.string(),
        title: z.string(),
        url: z.string()
      })
    )
  )
})

export const linearIssueSchema = linearIssueRowSchema.nullable()

// Nullish comments mean no comments at the consumer, not a failed issue read.
export const linearIssueCommentsSchema = detailCommentListSchema.nullish()

// Drop malformed label elements so the picker cannot render undefined chips.
export const githubRepoLabelsSchema = salvagingArray(z.string())

export const githubAssignableUsersSchema = assignableUserListSchema

// Picker identity/name/type are read unguarded; color has a row fallback.
export const linearTeamStatesSchema = salvagingArray(
  z.looseObject({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    color: prText('color')
  })
)

// Hydration and composer share team identity requirements but differ on refusal policy.
export const linearTeamsSchema = salvagingArray(
  z.looseObject({
    id: z.string(),
    name: z.string(),
    key: z.string(),
    workspaceId: prText('workspaceId'),
    workspaceName: prText('workspaceName')
  })
)
