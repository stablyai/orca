import { z } from 'zod'
import { JiraIssueLinkSchema } from '../../../../shared/jira-issue-link-schema'
import { isJiraIssueLinkSourceContextMatch } from '../../../../shared/jira-issue-link'
import { TaskSourceContextSchema } from '../../../../shared/task-source-context-schema'

export const WorktreeJiraIssueLinkFields = {
  linkedJiraIssue: JiraIssueLinkSchema.nullable().optional(),
  linkedJiraIssueSourceContext: TaskSourceContextSchema.nullable().optional()
}

export function assertJiraIssueSourceContextMatch(
  params: {
    linkedJiraIssue?: z.infer<typeof JiraIssueLinkSchema> | null
    linkedJiraIssueSourceContext?: z.infer<typeof TaskSourceContextSchema> | null
  },
  ctx: z.RefinementCtx
): void {
  if (
    params.linkedJiraIssue &&
    params.linkedJiraIssueSourceContext &&
    !isJiraIssueLinkSourceContextMatch(params.linkedJiraIssue, params.linkedJiraIssueSourceContext)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Linked Jira issue and source context identities must match'
    })
  }
}
