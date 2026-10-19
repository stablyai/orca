import { resolveIssueGitHubApiRepositorySource } from './github-api-repository'
import type { getWorkItem } from './client'
import type { WorkItemRepositoryLookup } from './client/fetch/get-work-item'

// Why: detail tests replace item lookup; retain its selected-source metadata.
export function makeWorkItemDetailsLookupMock(lookup: typeof getWorkItem) {
  return async (...args: Parameters<typeof getWorkItem>): Promise<WorkItemRepositoryLookup> => {
    const item = await lookup(...args)
    return {
      item,
      repository:
        item?.type === 'issue'
          ? (await resolveIssueGitHubApiRepositorySource(args[0], args[5], args[3], args[4])).source
          : null
    }
  }
}
