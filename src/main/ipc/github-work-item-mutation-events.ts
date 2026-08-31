import { sendToTrustedUIRenderer } from './ui'

export type GitHubWorkItemMutation = {
  repoPath: string
  repoId?: string
  type: 'issue' | 'pr'
  number: number
}

export function broadcastGitHubWorkItemMutation(
  payload: GitHubWorkItemMutation,
  senderId?: number
): void {
  sendToTrustedUIRenderer('gh:workItemMutated', payload, senderId)
}
