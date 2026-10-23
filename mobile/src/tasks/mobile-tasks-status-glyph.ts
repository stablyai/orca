import type { LucideIcon } from 'lucide-react-native'
import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  CircleX,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Lock,
  colors
} from './mobile-tasks-dependencies'
import type { TaskItem } from './mobile-tasks-project-workspace-types'
import type { GitHubProjectRow, LinearIssue } from './mobile-tasks-legacy-foundation'
import type { BadgeTone } from '../components/ui/Badge'

/** One state glyph per row: the shape says the kind and state, the colour matches desktop. */
export type TaskStatusGlyph = {
  icon: LucideIcon
  color: string
  label: string
}

const OPEN = colors.statusGreen
const DONE = colors.statusPurple
const QUIET = colors.textMuted

function hostedReviewGlyph(state: string, label: string): TaskStatusGlyph {
  if (state === 'merged') {
    return { icon: GitMerge, color: DONE, label }
  }
  if (state === 'closed') {
    return { icon: GitPullRequestClosed, color: colors.statusRed, label }
  }
  if (state === 'draft') {
    return { icon: GitPullRequestDraft, color: QUIET, label }
  }
  if (state === 'locked') {
    return { icon: Lock, color: QUIET, label }
  }
  return { icon: GitPullRequest, color: OPEN, label }
}

function issueGlyph(state: string, label: string): TaskStatusGlyph {
  if (state === 'closed') {
    return { icon: CircleCheck, color: DONE, label }
  }
  if (state === 'locked') {
    return { icon: Lock, color: QUIET, label }
  }
  return { icon: CircleDot, color: OPEN, label }
}

/** Linear's own state shapes, tinted with the team's state colour. */
export function linearStateGlyph(state: LinearIssue['state']): TaskStatusGlyph {
  const color = state.color || QUIET
  const label = state.name
  switch (state.type) {
    case 'backlog':
    case 'triage':
      return { icon: CircleDashed, color, label }
    case 'started':
      return { icon: CircleDot, color, label }
    case 'completed':
      return { icon: CircleCheck, color, label }
    case 'canceled':
      return { icon: CircleX, color, label }
    default:
      return { icon: Circle, color, label }
  }
}

export function taskStatusGlyph(item: TaskItem): TaskStatusGlyph {
  switch (item.provider) {
    case 'github':
      return item.source.type === 'pr'
        ? hostedReviewGlyph(item.source.state, item.status)
        : issueGlyph(item.source.state, item.status)
    case 'gitlab':
      return item.source.type === 'mr'
        ? hostedReviewGlyph(item.source.state, item.status)
        : issueGlyph(item.source.state, item.status)
    case 'gitlabTodo':
      return { icon: CircleDot, color: colors.accentBlue, label: item.status }
    case 'linear':
      return linearStateGlyph(item.source.state)
    case 'jira': {
      const category = item.source.status.categoryKey
      if (category === 'done') {
        return { icon: CircleCheck, color: OPEN, label: item.status }
      }
      if (category === 'indeterminate') {
        return {
          icon: CircleDot,
          color: colors.accentBlue,
          label: item.status
        }
      }
      return { icon: Circle, color: colors.textSecondary, label: item.status }
    }
  }
}

export function projectRowStatusGlyph(row: GitHubProjectRow, label: string): TaskStatusGlyph {
  if (row.itemType === 'DRAFT_ISSUE') {
    return { icon: CircleDashed, color: QUIET, label }
  }
  if (row.itemType === 'REDACTED') {
    return { icon: Lock, color: QUIET, label }
  }
  if (row.itemType === 'PULL_REQUEST') {
    const state = row.content.isDraft
      ? 'draft'
      : row.content.state === 'MERGED'
        ? 'merged'
        : row.content.state === 'CLOSED'
          ? 'closed'
          : 'open'
    return hostedReviewGlyph(state, label)
  }
  if (row.content.state === 'CLOSED') {
    return row.content.stateReason === 'NOT_PLANNED'
      ? { icon: CircleSlash, color: QUIET, label }
      : { icon: CircleCheck, color: DONE, label }
  }
  return { icon: CircleDot, color: OPEN, label }
}

export function signalBadgeTone(tone: 'neutral' | 'success' | 'warning' | 'danger'): BadgeTone {
  return tone === 'success'
    ? 'green'
    : tone === 'warning'
      ? 'amber'
      : tone === 'danger'
        ? 'red'
        : 'neutral'
}
