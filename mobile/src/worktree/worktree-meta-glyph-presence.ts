import type { WorktreeCardDetails } from '../../../src/shared/worktree/card-properties'
import type { Worktree } from './workspace-list-types'

export type WorktreeMetaGlyphPresence = {
  notes: boolean
  automation: boolean
  cli: boolean
  issue: boolean
  jira: boolean
  linear: boolean
  gitLabMR: boolean
}

// Accept unknown because rows are unchecked and older hosts omit attachments.
function hasLinkedJiraIssue(linkedItems: unknown): boolean {
  return (
    Array.isArray(linkedItems) &&
    linkedItems.some(
      (item: unknown) =>
        typeof item === 'object' &&
        item !== null &&
        'provider' in item &&
        item.provider === 'jira' &&
        'type' in item &&
        item.type === 'issue'
    )
  )
}

export function getWorktreeMetaGlyphPresence(
  item: Worktree,
  details: WorktreeCardDetails
): WorktreeMetaGlyphPresence {
  return {
    notes: details.comment && (item.comment ?? '').trim().length > 0,
    automation: details.automation && item.automationCreated === true,
    cli: details.cli && item.cliCreated === true,
    issue: details.issue && (item.linkedIssue != null || item.linkedGitLabIssue != null),
    jira: details.jiraIssue && hasLinkedJiraIssue(item.linkedItems),
    linear: details.linearIssue && Boolean(item.linkedLinearIssue),
    gitLabMR: details.pr && item.linkedGitLabMR != null
  }
}
