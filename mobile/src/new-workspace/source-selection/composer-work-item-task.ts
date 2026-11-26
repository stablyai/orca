import type { WorkspaceSourceLinkedItem as MobileLinkedWorkItem } from '../../../../src/shared/new-workspace/workspace-source'
import type { WorkspaceCreateTaskItem } from '../creation/workspace-create-params'

/** The composer's linked issue, PR or ticket, as the host's task-workspace source. */
export function toTaskItem(
  item: MobileLinkedWorkItem,
  targetRepoId: string
): WorkspaceCreateTaskItem {
  if (item.provider === 'github') {
    return {
      provider: 'github',
      source: {
        type: item.type === 'pr' ? 'pr' : 'issue',
        repoId: item.repoId ?? targetRepoId,
        number: item.number,
        title: item.title,
        url: item.url
      }
    }
  }
  if (item.provider === 'gitlab') {
    return {
      provider: 'gitlab',
      source: {
        type: item.type === 'mr' ? 'mr' : 'issue',
        repoId: item.repoId ?? targetRepoId,
        number: item.number,
        title: item.title,
        url: item.url
      }
    }
  }
  if (item.provider === 'jira') {
    return {
      provider: 'jira',
      source: {
        key: item.jiraIdentifier ?? '',
        title: item.title,
        url: item.url
      }
    }
  }
  return {
    provider: 'linear',
    source: {
      identifier: item.linearIdentifier ?? '',
      title: item.title,
      url: item.url,
      ...(item.linearWorkspaceId ? { workspaceId: item.linearWorkspaceId } : {}),
      ...(item.linearOrganizationUrlKey
        ? { organizationUrlKey: item.linearOrganizationUrlKey }
        : {})
    }
  }
}
