import { type ReactNode, View, Text } from './mobile-tasks-dependencies'
import { gitLabTodoTargetLabel } from './mobile-tasks-item-mapping'
import { COMMENT_REACTION_EMOJI } from './mobile-tasks-options'
import type { DetailCommentGroup } from './mobile-tasks-view-state-types'
import type { TaskItem } from './mobile-tasks-project-workspace-types'
import type { DetailComment } from './mobile-tasks-provider-detail-types'
import { styles } from './mobile-tasks-legacy-styles'

export function taskKindLabel(item: TaskItem): string {
  if (item.provider === 'github') {
    return item.source.type === 'pr' ? 'Pull request' : 'Issue'
  }
  if (item.provider === 'gitlab') {
    return item.source.type === 'mr' ? 'Merge request' : 'Issue'
  }
  if (item.provider === 'gitlabTodo') {
    return `${gitLabTodoTargetLabel(item.source)} todo`
  }
  return 'Linear ticket'
}

export function taskExternalOpenLabel(item: TaskItem): string {
  if (item.provider === 'github') {
    return 'Open in GitHub'
  }
  if (item.provider === 'gitlab' || item.provider === 'gitlabTodo') {
    return 'Open in GitLab'
  }
  return 'Open in Linear'
}

export function taskStatusActionLabel(item: TaskItem): string {
  const verb =
    item.provider === 'github' || item.provider === 'gitlab'
      ? item.source.state === 'closed'
        ? 'Reopen'
        : 'Close'
      : ''
  return verb ? `${verb} ${taskKindLabel(item).toLowerCase()}` : ''
}

export function isGitHubPrMergeBlocked(item: Extract<TaskItem, { provider: 'github' }>): boolean {
  return item.source.type === 'pr' && item.source.mergeable === 'CONFLICTING'
}

export function commentAuthor(comment: DetailComment): string {
  return comment.author ?? comment.user?.displayName ?? 'unknown'
}

export function commentDate(value: string | undefined): string {
  if (!value) {
    return ''
  }
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toLocaleDateString() : ''
}

export function formatDurationSeconds(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return ''
  }
  const seconds = Math.max(0, Math.floor(value))
  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  }
  return `${seconds}s`
}

export function commentSourceLabel(comment: DetailComment): string {
  if (comment.path) {
    const line =
      typeof comment.line === 'number'
        ? typeof comment.startLine === 'number' && comment.startLine !== comment.line
          ? `${comment.startLine}-${comment.line}`
          : String(comment.line)
        : ''
    const location = line ? `${comment.path}:${line}` : comment.path
    return `${comment.isResolved ? 'Resolved review' : 'Review'} · ${location}`
  }
  if (comment.threadId) {
    return comment.isResolved ? 'Resolved review thread' : 'Review thread'
  }
  return 'Top-level comment'
}

export function groupDetailComments(comments: DetailComment[]): DetailCommentGroup[] {
  const threads = new Map<string, { root: DetailComment; replies: DetailComment[] }>()
  const groups: DetailCommentGroup[] = []
  const emittedThreads = new Set<string>()

  for (const comment of comments) {
    if (!comment.threadId) {
      continue
    }
    const existing = threads.get(comment.threadId)
    if (existing) {
      existing.replies.push(comment)
    } else {
      threads.set(comment.threadId, { root: comment, replies: [] })
    }
  }

  for (const comment of comments) {
    if (!comment.threadId) {
      groups.push({ kind: 'standalone', comment })
      continue
    }
    if (emittedThreads.has(comment.threadId)) {
      continue
    }
    emittedThreads.add(comment.threadId)
    const thread = threads.get(comment.threadId)
    if (thread) {
      groups.push({ kind: 'thread', threadId: comment.threadId, ...thread })
    }
  }

  return groups
}

export function detailCommentGroupId(group: DetailCommentGroup): string {
  return group.kind === 'thread' ? `thread:${group.threadId}` : `comment:${group.comment.id}`
}

export function detailCommentGroupRoot(group: DetailCommentGroup): DetailComment {
  return group.kind === 'thread' ? group.root : group.comment
}

export function detailCommentGroupCount(group: DetailCommentGroup): number {
  return group.kind === 'thread' ? 1 + group.replies.length : 1
}

export function isResolvedDetailCommentGroup(group: DetailCommentGroup): boolean {
  return detailCommentGroupRoot(group).isResolved === true
}

export function discussionSummary(count: number): string {
  if (count === 0) {
    return 'No comments yet'
  }
  return `${count} ${count === 1 ? 'comment' : 'comments'}`
}

export function renderCommentReactions(comment: DetailComment): ReactNode {
  const reactions = (comment.reactions ?? []).filter((reaction) => reaction.count > 0)
  if (reactions.length === 0) {
    return null
  }
  return (
    <View style={styles.reactionRow}>
      {reactions.map((reaction) => (
        <View key={reaction.content} style={styles.reactionChip}>
          <Text style={styles.reactionText}>
            {COMMENT_REACTION_EMOJI[reaction.content]} {reaction.count}
          </Text>
        </View>
      ))}
    </View>
  )
}
