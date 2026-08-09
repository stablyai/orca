import { z } from 'zod'
import { LINEAR_ISSUE_ATTRIBUTE_FILTER_ID_MAX_LENGTH } from '../../../../shared/linear-issue-attribute-filter'
import {
  LINEAR_DISPLAY_PROPERTIES,
  LINEAR_GROUP_BY_OPTIONS,
  LINEAR_ORDER_BY_OPTIONS,
  LINEAR_VIEW_MODES
} from '../../../../shared/linear-issue-view-resume-state'
import type { TaskResumeState as TaskResumeStateType } from '../../../../shared/types'
import { LinearIssueAttributeFilterSchema } from './linear-issue-attribute-filter-schema'
import type { AssertNoExtraKeys, AssertNoMissingKeys } from './ui-state-schema-parity'

// Why: built from the shared catalogs and the existing bounded filter schema, so
// adding a view option cannot leave paired clients rejected by a stale enum.
const LinearIssueViewResumeState = z
  .object({
    viewMode: z.enum(LINEAR_VIEW_MODES),
    groupBy: z.enum(LINEAR_GROUP_BY_OPTIONS),
    orderBy: z.enum(LINEAR_ORDER_BY_OPTIONS),
    displayProperties: z
      .array(z.enum(LINEAR_DISPLAY_PROPERTIES))
      .max(LINEAR_DISPLAY_PROPERTIES.length),
    teamPropertyTouched: z.boolean(),
    filtersByWorkspaceId: z.record(
      z.string().min(1).max(LINEAR_ISSUE_ATTRIBUTE_FILTER_ID_MAX_LENGTH),
      LinearIssueAttributeFilterSchema
    )
  })
  .strict()

// Why: the `.catch` below is a silent data loss — a client whose saved shape this
// schema rejects loses its view on every write with no other trace. Log the issue
// paths (not the values, which carry workspace facet ids) so the drift is findable.
function reportDiscardedLinearIssueView(ctx: z.core.$ZodCatchCtx): undefined {
  console.warn(
    '[ui.set] discarded an invalid taskResumeState.linearIssueView',
    // Raw issues carry no path for a failure on the value itself, only for nested ones.
    ctx.issues.map((issue) => ({ path: (issue.path ?? []).join('.'), code: issue.code }))
  )
  return undefined
}

/** Tasks page-position state persisted through `ui.set`; mirrors `TaskResumeState`. */
export const TaskResumeState = z
  .object({
    githubMode: z.enum(['items', 'project']).optional(),
    githubItemsPreset: z.string().nullable().optional(),
    githubItemsQuery: z.string().optional(),
    githubProjectHiddenFieldIdsByView: z.record(z.string(), z.array(z.string())).optional(),
    linearMode: z.enum(['issues', 'projects', 'views', 'in-orca']).optional(),
    linearPreset: z.enum(['assigned', 'created', 'all', 'completed']).optional(),
    linearQuery: z.string().optional(),
    linearContext: z
      .object({
        kind: z.enum(['project', 'view']),
        id: z.string(),
        workspaceId: z.string(),
        model: z.enum(['issue', 'project']).optional()
      })
      .strict()
      .optional(),
    // Why: value tolerance stops at the top level, so without `.catch` one bad view
    // value drops the whole taskResumeState — github/jira/linear query included —
    // for paired clients on every subsequent write, not just this one.
    linearIssueView: LinearIssueViewResumeState.optional().catch(reportDiscardedLinearIssueView),
    jiraPreset: z.enum(['assigned', 'reported', 'all', 'done']).optional(),
    jiraQuery: z.string().optional()
  })
  .strict()

const _taskResumeStateParity: AssertNoMissingKeys<
  TaskResumeStateType,
  z.infer<typeof TaskResumeState>
> = true
void _taskResumeStateParity

// Why: the top-level assertion only compares TaskResumeState's own keys, so a field
// added one level down stays invisible to it — and `.strict()` rejects exactly that.
const _linearIssueViewParity: AssertNoMissingKeys<
  NonNullable<TaskResumeStateType['linearIssueView']>,
  z.infer<typeof LinearIssueViewResumeState>
> = true
void _linearIssueViewParity

// Why: `.strict()` only rejects keys the SCHEMA omits. A key the schema gains and the
// shared type lacks passes validation and reaches the renderer unmodelled instead.
const _linearIssueViewExtraKeys: AssertNoExtraKeys<
  NonNullable<TaskResumeStateType['linearIssueView']>,
  z.infer<typeof LinearIssueViewResumeState>
> = true
void _linearIssueViewExtraKeys
