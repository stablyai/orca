import { parseLinearIssueInput } from '../../shared/linear-links'
import { getConnectedWorkspaces } from './issue-context-client'
import { linearError } from './issue-context-errors'

export type CurrentIssueLink = {
  identifier: string
  workspaceId?: string | null
  organizationUrlKey?: string | null
  worktreeId?: string
  worktreePath?: string
  backfill?: {
    workspaceId?: string | null
    organizationUrlKey?: string | null
  }
}

export function getLinearCurrentIssueFromWorktree(worktree: {
  id: string
  path: string
  linkedLinearIssue?: string | null
  linkedLinearIssueWorkspaceId?: string | null
  linkedLinearIssueOrganizationUrlKey?: string | null
}): CurrentIssueLink {
  const linked = worktree.linkedLinearIssue?.trim()
  if (!linked) {
    throw linearError('linear_no_linked_issue', 'The current worktree is not linked to Linear.', {
      nextSteps: ['Open a Linear-linked worktree or pass an explicit issue id.']
    })
  }
  const parsed = parseLinearIssueInput(linked)
  return {
    identifier: parsed?.identifier ?? linked.toUpperCase(),
    workspaceId: worktree.linkedLinearIssueWorkspaceId,
    organizationUrlKey:
      worktree.linkedLinearIssueOrganizationUrlKey ?? parsed?.organizationUrlKey ?? null,
    worktreeId: worktree.id,
    worktreePath: worktree.path
  }
}

export function resolveLegacyLinearLinkWorkspace(
  identifier: string,
  splitOrganizationUrlKey?: string | null
): CurrentIssueLink['backfill'] {
  const parsed = parseLinearIssueInput(identifier)
  const organizationUrlKey = splitOrganizationUrlKey ?? parsed?.organizationUrlKey
  if (!organizationUrlKey) {
    return undefined
  }
  const matches = getConnectedWorkspaces().filter(
    (workspace) => workspace.organizationUrlKey === organizationUrlKey
  )
  return matches.length === 1
    ? { workspaceId: matches[0].id, organizationUrlKey }
    : { organizationUrlKey }
}
