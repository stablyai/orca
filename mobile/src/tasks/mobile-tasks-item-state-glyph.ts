import {
  Circle,
  CircleCheck,
  CircleDot,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon
} from 'lucide-react-native'
import { prStateColor } from '../components/WorktreeMetaGlyphs'
import { colors } from '../theme/mobile-theme'
import type { TaskItem } from './mobile-tasks-project-workspace-types'

export type TaskItemStateGlyph = { icon: LucideIcon; color: string }

// The shape says issue or review and its state, coloured as desktop's task page and review icons.
function reviewGlyph(state: string): TaskItemStateGlyph {
  const color = prStateColor(state === 'opened' ? 'open' : state)
  if (state === 'merged') {
    return { icon: GitMerge, color }
  }
  if (state === 'closed') {
    return { icon: GitPullRequestClosed, color }
  }
  if (state === 'draft') {
    return { icon: GitPullRequestDraft, color }
  }
  return { icon: GitPullRequest, color }
}

function issueGlyph(state: string): TaskItemStateGlyph {
  if (state === 'closed') {
    return { icon: CircleCheck, color: colors.statusPurple }
  }
  if (state === 'open' || state === 'opened') {
    return { icon: CircleDot, color: colors.statusGreen }
  }
  return { icon: CircleDot, color: colors.textMuted }
}

export function taskItemStateGlyph(item: TaskItem): TaskItemStateGlyph {
  switch (item.provider) {
    case 'github':
      return item.source.type === 'pr'
        ? reviewGlyph(item.source.state)
        : issueGlyph(item.source.state)
    case 'gitlab':
      return item.source.type === 'mr'
        ? reviewGlyph(item.source.state)
        : issueGlyph(item.source.state)
    case 'gitlabTodo':
      return { icon: CircleDot, color: colors.accentBlue }
    case 'linear':
      return { icon: CircleDot, color: item.source.state.color || colors.textMuted }
    case 'jira': {
      const category = item.source.status.categoryKey
      if (category === 'done') {
        return { icon: CircleCheck, color: colors.statusGreen }
      }
      return category === 'indeterminate'
        ? { icon: CircleDot, color: colors.accentBlue }
        : { icon: Circle, color: colors.textSecondary }
    }
  }
}
