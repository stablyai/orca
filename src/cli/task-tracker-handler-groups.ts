import { CLICKUP_HANDLER_GROUP } from './clickup-handler-group'
import type { HandlerGroup } from './handler-group-manifest'
import { JIRA_HANDLER_GROUP } from './jira-handler-group'

// Why split out: account-backed trackers each ship a long command list, so they stay out of the manifest.
export const TASK_TRACKER_HANDLER_GROUPS: readonly HandlerGroup[] = [
  JIRA_HANDLER_GROUP,
  CLICKUP_HANDLER_GROUP
]
