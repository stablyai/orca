import { z } from 'zod'
import type { TaskResumeState as TaskResumeStateType } from '../../../../shared/types'
import type { AssertNoMissingKeys } from './ui-state-schema-parity'

/**
 * Tasks page-position state persisted through `ui.set`; mirrors `TaskResumeState`.
 *
 * This object is `.strict()` and sits behind `ui.set`'s field-level `.catch`, so a key
 * a host predates makes that host drop the ENTIRE resume state — github and jira with
 * it — and report success. Only add a field here when clients must agree on it across
 * versions; per-device view preferences belong in client-local storage instead.
 */
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
    jiraPreset: z.enum(['assigned', 'reported', 'all', 'done']).optional(),
    jiraQuery: z.string().optional()
  })
  .strict()

const _taskResumeStateParity: AssertNoMissingKeys<
  TaskResumeStateType,
  z.infer<typeof TaskResumeState>
> = true
void _taskResumeStateParity
