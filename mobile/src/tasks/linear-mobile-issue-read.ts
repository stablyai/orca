export type LinearMobileIssue = {
  id: string
  workspaceId?: string
  workspaceName?: string
  identifier: string
  title: string
  description?: string
  url: string
  state: { name: string; type: string; color: string }
  team: { id: string; name: string; key: string }
  project?: { id: string; name: string; url?: string; color?: string }
  subIssues?: Array<{ id: string; identifier: string; title: string; url: string }>
  labels: string[]
  labelIds?: string[]
  assignee?: { id?: string; displayName: string }
  estimate?: number | null
  priority: number
  updatedAt: string
}

type LinearIssueReadEnvelope = {
  items?: unknown
}

export function extractLinearIssueReadItems(result: unknown): LinearMobileIssue[] {
  if (Array.isArray(result)) {
    return result as LinearMobileIssue[]
  }

  if (
    result &&
    typeof result === 'object' &&
    Array.isArray((result as LinearIssueReadEnvelope).items)
  ) {
    return (result as { items: LinearMobileIssue[] }).items
  }

  throw new Error('Unexpected Linear tasks response')
}
