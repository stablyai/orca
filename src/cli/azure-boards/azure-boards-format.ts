import type {
  AzureBoardsConnection,
  AzureDevOpsWorkItemComment,
  AzureDevOpsWorkItemSearchPage
} from '../../shared/azure-devops/azure-boards-agent-types'
import type {
  AzureDevOpsAssignedWorkItemsPage,
  AzureDevOpsTeam,
  AzureDevOpsWorkItem,
  AzureDevOpsWorkItemDetail
} from '../../shared/azure-devops/boards-types'

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&amp;': '&'
}

/** Azure DevOps stores rich text as HTML; the terminal gets its text, line breaks kept. */
export function azureBoardsHtmlToText(html: string | null): string {
  if (!html) {
    return ''
  }
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (entity, code: string) => {
      const point =
        code[0] === 'x' || code[0] === 'X' ? Number.parseInt(code.slice(1), 16) : Number(code)
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity
    })
    .replace(/&(nbsp|lt|gt|quot|#39|amp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function workItemLine(item: AzureDevOpsWorkItem): string {
  const assignee = item.assignedTo?.displayName ?? 'unassigned'
  return `${item.id}\t${item.workItemType}\t${item.state}\t${assignee}\t${item.title}`
}

export function formatAzureBoardsConnection(connection: AzureBoardsConnection): string {
  return [
    `Project: ${connection.organization ? `${connection.organization}/` : ''}${connection.project}`,
    `Repository: ${connection.repository}`,
    `Signed in: ${connection.authenticated ? (connection.account ?? 'yes') : 'no'}`,
    `Credential: ${connection.credentialSource ?? 'none (run az login)'}`
  ].join('\n')
}

export function formatAzureBoardsWorkItem(item: AzureDevOpsWorkItemDetail | null): string {
  if (!item) {
    return 'Work item not found.'
  }
  const description = azureBoardsHtmlToText(item.descriptionHtml)
  const criteria = azureBoardsHtmlToText(item.acceptanceCriteriaHtml)
  return [
    `${item.workItemType} ${item.id}: ${item.title}`,
    `State: ${item.state}`,
    `Assigned to: ${item.assignedTo?.displayName ?? 'unassigned'}`,
    `Area: ${item.areaPath}`,
    `Iteration: ${item.iterationPath}`,
    ...(item.tags.length > 0 ? [`Tags: ${item.tags.join(', ')}`] : []),
    ...(item.parentId !== null ? [`Parent: ${item.parentId}`] : []),
    ...(item.childIds.length > 0 ? [`Children: ${item.childIds.join(', ')}`] : []),
    ...(item.pullRequestLinks.length > 0
      ? [`Pull requests: ${item.pullRequestLinks.map((link) => `#${link.id}`).join(', ')}`]
      : []),
    `URL: ${item.url}`,
    ...(description ? ['', 'Description:', description] : []),
    ...(criteria ? ['', 'Acceptance criteria:', criteria] : [])
  ].join('\n')
}

export function formatAzureBoardsWorkItemList(
  page: AzureDevOpsWorkItemSearchPage | AzureDevOpsAssignedWorkItemsPage
): string {
  if (page.items.length === 0) {
    return 'No work items.'
  }
  const truncated =
    'truncatedAtLimit' in page && page.truncatedAtLimit
      ? page.truncatedAtLimit
      : 'truncatedAtQueryLimit' in page
        ? page.truncatedAtQueryLimit
        : undefined
  return [
    ...page.items.map(workItemLine),
    ...(truncated ? [`(first ${truncated}; narrow the query to see the rest)`] : [])
  ].join('\n')
}

export function formatAzureBoardsComments(comments: AzureDevOpsWorkItemComment[]): string {
  if (comments.length === 0) {
    return 'No comments.'
  }
  return comments
    .map(
      (comment) =>
        `${comment.createdDate ?? ''} ${comment.author ?? 'unknown'}:\n${azureBoardsHtmlToText(comment.textHtml)}`
    )
    .join('\n\n')
}

export function formatAzureBoardsTeams(teams: AzureDevOpsTeam[]): string {
  return teams.map((team) => `${team.name}${team.isDefault ? '\t(default)' : ''}`).join('\n')
}
