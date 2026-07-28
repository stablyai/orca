import { z } from 'zod'
import type { TaskResumeState as TaskResumeStateType } from '../../../../shared/types'
import type { AssertNoMissingKeys } from './ui-state-schema-parity'
import {
  MAX_JIRA_SAVED_FILTERS,
  MAX_JIRA_SAVED_FILTER_ID_LENGTH,
  MAX_JIRA_SAVED_FILTER_JQL_LENGTH,
  MAX_JIRA_SAVED_FILTER_NAME_LENGTH
} from '../../../../shared/jira-saved-filters'

const JiraSavedFilter = z
  .object({
    id: z.string().trim().min(1).max(MAX_JIRA_SAVED_FILTER_ID_LENGTH),
    name: z.string().trim().min(1).max(MAX_JIRA_SAVED_FILTER_NAME_LENGTH),
    jql: z.string().trim().min(1).max(MAX_JIRA_SAVED_FILTER_JQL_LENGTH)
  })
  .strict()

/** Tasks page-position state persisted through `ui.set`; mirrors `TaskResumeState`. */
export const TaskResumeState = z
  .object({
    githubMode: z.enum(['items', 'project']).optional(),
    githubItemsPreset: z.string().nullable().optional(),
    githubItemsQuery: z.string().optional(),
    githubProjectHiddenFieldIdsByView: z.record(z.string(), z.array(z.string())).optional(),
    linearMode: z.enum(['issues', 'projects', 'views']).optional(),
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
    jiraQuery: z.string().optional(),
    jiraSavedFilters: z.array(JiraSavedFilter).max(MAX_JIRA_SAVED_FILTERS).optional(),
    jiraActiveSavedFilterId: z
      .string()
      .trim()
      .min(1)
      .max(MAX_JIRA_SAVED_FILTER_ID_LENGTH)
      .nullable()
      .optional()
  })
  .strict()

const _taskResumeStateParity: AssertNoMissingKeys<
  TaskResumeStateType,
  z.infer<typeof TaskResumeState>
> = true
void _taskResumeStateParity
