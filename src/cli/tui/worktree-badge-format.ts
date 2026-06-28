import type { WorktreeBadges } from './worktree-snapshot'

/** Render the provider-agnostic badges as a compact, color-free string.
 *  Order: issue link, then terminal count, then unread marker. Only the first
 *  present issue/PR/MR/Linear link is shown to keep rows scannable. */
export function formatBadges(badges: WorktreeBadges): string {
  const parts: string[] = []

  // Loose `!= null` so an undefined link field renders nothing, not "undefined".
  if (badges.pr) {
    parts.push(`#${badges.pr.number}`)
  } else if (badges.gitLabMr != null) {
    parts.push(`!${badges.gitLabMr}`)
  } else if (badges.linearIssue != null) {
    parts.push(badges.linearIssue)
  } else if (badges.issue != null) {
    parts.push(`#${badges.issue}`)
  } else if (badges.gitLabIssue != null) {
    parts.push(`#${badges.gitLabIssue}`)
  }

  if (badges.liveTerminalCount > 0) {
    parts.push(`⌗${badges.liveTerminalCount}`)
  }
  if (badges.unread) {
    parts.push('•')
  }

  return parts.join(' ')
}
