import type { CheckStatus } from '../../../src/shared/github/pull-request-types'
import {
  getWorkspaceAttachmentKey,
  getWorkspaceAttachmentUrlScope
} from '../../../src/shared/workspace-attachment-normalization'
import {
  getWorkspaceAttachments,
  workspaceAttachmentReferenceLabel
} from '../../../src/shared/workspace-attachments'
import type { WorkspaceAttachment } from '../../../src/shared/worktree/types'
import type { Worktree } from './workspace-list-types'

export type WorkspaceDetailLink = {
  key: string
  provider: WorkspaceAttachment['provider']
  type: WorkspaceAttachment['type']
  number: number
  /** `PR #12`, `MR !3`, `Issue #4`, or the tracker's own key (`ENG-12`). */
  label: string
  title?: string
  url?: string
  /** Review state (`open`, `merged`, ...); reviews only. */
  state?: string
  checks?: CheckStatus
}

export type WorkspaceOrigin = { kind: 'automation'; name?: string } | { kind: 'cli' }

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

// Only web links leave the app; anything else on the wire is shown but not opened.
function webUrl(value: unknown): string | undefined {
  const url = optionalText(value)
  return url && /^https?:\/\//i.test(url) ? url : undefined
}

function toDetailLink(item: WorkspaceAttachment): WorkspaceDetailLink {
  return {
    key: getWorkspaceAttachmentKey(item),
    provider: item.provider,
    type: item.type,
    number: item.number,
    label: workspaceAttachmentReferenceLabel(item),
    title: optionalText(item.title),
    url: webUrl(item.url)
  }
}

// Read linkedItems with legacy singular-field fallback; enrich the branch PR from linkedPR and keep reviews before tasks.
export function buildWorkspaceDetailLinks(row: Worktree): WorkspaceDetailLink[] {
  const pr = row.linkedPR
  const items = getWorkspaceAttachments({
    linkedItems: row.linkedItems,
    linkedPR: pr?.number ?? null,
    linkedIssue: row.linkedIssue ?? null,
    linkedGitLabMR: row.linkedGitLabMR ?? null,
    linkedGitLabIssue: row.linkedGitLabIssue ?? null,
    linkedLinearIssue: optionalText(row.linkedLinearIssue) ?? null
  })
  const links = items.map(toDetailLink)
  if (pr) {
    const branchPR: WorkspaceAttachment = {
      provider: 'github',
      type: 'pr',
      number: pr.number,
      url: webUrl(pr.url)
    }
    const enrich = (link: WorkspaceDetailLink): WorkspaceDetailLink => ({
      ...link,
      title: optionalText(pr.title) ?? link.title,
      url: branchPR.url ?? link.url,
      state: pr.state,
      checks: pr.checksStatus
    })
    const index = items.findIndex((item) => isBranchPRAttachment(item, branchPR, row.repoId))
    if (index !== -1) {
      links[index] = enrich(links[index])
    } else {
      // A same-numbered PR in another repo absorbed the legacy entry; keep the branch PR visible.
      links.push(enrich(toDetailLink(branchPR)))
    }
  }
  return links.sort((a, b) => Number(a.type === 'issue') - Number(b.type === 'issue'))
}

// Same number is not enough: a linked PR from another repo must not take the branch PR's details.
function isBranchPRAttachment(
  item: WorkspaceAttachment,
  branchPR: WorkspaceAttachment,
  repoId: string
): boolean {
  if (item.provider !== 'github' || item.type !== 'pr' || item.number !== branchPR.number) {
    return false
  }
  if (item.repoId && item.repoId !== repoId) {
    return false
  }
  return (
    !item.url ||
    !branchPR.url ||
    getWorkspaceAttachmentUrlScope(item) === getWorkspaceAttachmentUrlScope(branchPR)
  )
}

export function buildWorkspaceOrigin(row: Worktree): WorkspaceOrigin | null {
  if (row.automationCreated) {
    // Older hosts send only the flag, so the name is optional.
    const name = optionalText(row.automationName)
    return name ? { kind: 'automation', name } : { kind: 'automation' }
  }
  return row.cliCreated ? { kind: 'cli' } : null
}

export function workspaceNotes(row: Pick<Worktree, 'comment'>): string | null {
  return optionalText(row.comment) ?? null
}
