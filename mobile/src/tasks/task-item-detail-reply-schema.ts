import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'
import {
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

// What one task item's detail sheet reads. Checked against the handlers in
// src/main/runtime/rpc/methods/ — github-repo-work-item-methods.ts:52-87, gitlab.ts:175-178,
// linear.ts:77-104 and :169-172 — and the shared results they return: GitHubWorkItemDetails in
// src/shared/github/work-item-types.ts, GitLabWorkItemDetails in src/shared/gitlab-types.ts,
// LinearIssue in src/shared/linear/issue-types.ts, and `Promise<string[]>` from
// src/main/github/issue-field-options.ts:15.

const MERGEABLE_STATE = ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] as const

/**
 * A GitHub work item's detail pane.
 *
 * Object or `null`, and nothing inside is required: `if (!details) throw` at
 * use-mobile-tasks-item-detail-loading.tsx:85 is the whole identity test, and :91-102 reads every
 * member behind `??` or `?.`. What the schema adds is the container — main read `details.body` off
 * a string reply and published an empty sheet as if the host had answered, and off `null` it threw
 * a property-read TypeError the sheet showed verbatim.
 *
 * `reviewDecision` keeps an explicit `null`, because the call site's own `?? actionItem.source
 * .reviewDecision` is what decides whether the host's null or the row's value wins; collapsing it
 * here would take that decision away from the call site.
 */
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

/**
 * A GitLab work item's detail pane, read the same way and required the same amount: not at all
 * past the container (use-mobile-tasks-item-detail-loading.tsx:136-158).
 *
 * `mergeable` is a closed arm set that degrades to absent rather than to an arm. The three arms
 * are what the row's merge affordance is keyed on, so coercing an arm this build has not heard of
 * into one of them would offer or withhold a merge against a state the client cannot place;
 * dropping the member leaves the row exactly as the list had it, which is what main did for a
 * detail reply that carried no `mergeable` at all.
 */
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

/**
 * One Linear issue, or `null` for an issue this workspace cannot see — which is what
 * `getIssue` (src/main/linear/linear-issue-lookups.ts:33) answers, and what both call sites
 * already report as "not found".
 *
 * This is the one detail reply with required members, because `createLinearTask`
 * (mobile-tasks-item-mapping.ts:291-300) reads six of them with no guard: `id`, `title`,
 * `identifier`, `updatedAt`, `team.name` and `state.name`. `url`, `labels` and `priority` join
 * them because the shared type declares them non-optional and the row renders them unguarded, and
 * the recorded reply at every site carries all nine.
 *
 * `estimate` keeps an explicit `null`: the host writes `issue.estimate ?? null`
 * (src/main/linear/mappers.ts:112), so `null` is the value "no estimate" and absence is a host
 * that did not report one.
 */
export const linearIssueSchema = z
  .looseObject({
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
  .nullable()

/**
 * The comment list beside a Linear issue.
 *
 * Nullish as well as an array, because the call site reads it as `accepted.value ?? []`
 * (use-mobile-tasks-item-detail-loading.tsx:215): a host that answers `null` still means "no
 * comments", and rejecting it would turn a reply main rendered into an error the sheet shows.
 */
export const linearIssueCommentsSchema = detailCommentListSchema.nullish()

/**
 * The repo's label vocabulary, for the label picker.
 *
 * `listLabels` returns `string[]`, and the picker maps it unguarded, so an element that is not a
 * string drops rather than rendering `undefined` as a chip.
 */
export const githubRepoLabelsSchema = salvagingArray(z.string())

/** The repo's assignable users, keyed by `login` the way every reader of this list is. */
export const githubAssignableUsersSchema = assignableUserListSchema

/**
 * A Linear team's workflow states, for the status picker.
 *
 * `id`, `name` and `type` are what `LinearState` declares non-optional and what the picker rows
 * and `setLinearStatus` read unguarded; `color` is reached through
 * `state.color ?? item.source.state.color` (use-mobile-tasks-github-reply-merge-actions.tsx:211).
 */
export const linearTeamStatesSchema = salvagingArray(
  z.looseObject({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    color: prText('color')
  })
)

/**
 * A Linear workspace's teams. One reader for the composer picker and for provider hydration, which
 * disagree only about what a refusal means.
 *
 * `id`, `name` and `key` are `LinearTeam`'s own required members; hydration's
 * `reconcileTeamSelection` maps `team.id` with no guard
 * (mobile-tasks-reviewer-linear.ts:204), and the composer labels each row by name and key.
 */
export const linearTeamsSchema = salvagingArray(
  z.looseObject({
    id: z.string(),
    name: z.string(),
    key: z.string(),
    workspaceId: prText('workspaceId'),
    workspaceName: prText('workspaceName')
  })
)
