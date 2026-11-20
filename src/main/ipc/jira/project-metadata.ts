import { registerAppHandler } from '../app-registry/app-handler-registry'

import {
  listCreateFields,
  listIssueTypes,
  listPriorities
} from '../../jira/jira-issue-create-metadata'
import { listProjects } from '../../jira/jira-project-queries'
import type { JiraSiteSelection } from '../../../shared/jira/jira-types'

export function registerJiraProjectMetadataHandlers(
  normalizeSiteId: (value: unknown) => string | undefined
): void {
  registerAppHandler('jira:listProjects', async (_event, args?: { siteId?: JiraSiteSelection }) => {
    return listProjects(normalizeSiteId(args?.siteId))
  })

  registerAppHandler(
    'jira:listIssueTypes',
    async (_event, args: { projectIdOrKey: string; siteId?: string }) => {
      if (typeof args?.projectIdOrKey !== 'string' || !args.projectIdOrKey.trim()) {
        return []
      }
      return listIssueTypes(args.projectIdOrKey.trim(), normalizeSiteId(args.siteId))
    }
  )

  registerAppHandler(
    'jira:listCreateFields',
    async (_event, args: { projectIdOrKey: string; issueTypeId: string; siteId?: string }) => {
      if (typeof args?.projectIdOrKey !== 'string' || !args.projectIdOrKey.trim()) {
        return []
      }
      if (typeof args?.issueTypeId !== 'string' || !args.issueTypeId.trim()) {
        return []
      }
      return listCreateFields(
        args.projectIdOrKey.trim(),
        args.issueTypeId.trim(),
        normalizeSiteId(args.siteId)
      )
    }
  )

  registerAppHandler('jira:listPriorities', async (_event, args?: { siteId?: string }) => {
    return listPriorities(normalizeSiteId(args?.siteId))
  })
}
