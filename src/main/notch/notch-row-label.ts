// Turns a session's workspace into the two lines a notch row shows.
// Pure by design: main does the synchronous store lookup and passes the result in, so this
// never reaches for `runtime.getWorktreePs()` on a path that must stay non-blocking.
import type { Worktree } from '../../shared/types'

export type NotchRowLabel = {
  /** Workspace name. */
  title: string
  /** Branch, short SHA, or empty for a workspace with no git identity. */
  subtitle: string
}

const DETACHED_SHA_LENGTH = 7

function firstNonEmpty(...values: (string | undefined | null)[]): string {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) {
      return trimmed
    }
  }
  return ''
}

export type BuildNotchRowLabelArgs = {
  /** Null when the pane's workspace is gone or was never resolved. */
  worktree: Pick<Worktree, 'displayName' | 'branch' | 'head'> | null
  agentType?: string
  fallbackTitle: string
}

/**
 * Why: folder workspaces arrive as a Worktree with empty branch and head, so a naive
 * "branch ?? head" renders a blank second line rather than omitting it.
 */
export function buildNotchRowLabel({
  worktree,
  agentType,
  fallbackTitle
}: BuildNotchRowLabelArgs): NotchRowLabel {
  const title = firstNonEmpty(worktree?.displayName, agentType, fallbackTitle)

  if (!worktree) {
    return { title, subtitle: '' }
  }

  const branch = worktree.branch?.trim() ?? ''
  if (branch) {
    return { title, subtitle: branch }
  }

  // Detached HEAD still has an identity worth showing; a folder workspace has neither.
  const head = worktree.head?.trim() ?? ''
  return { title, subtitle: head ? head.slice(0, DETACHED_SHA_LENGTH) : '' }
}
