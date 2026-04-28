import type { GitHubReaction, GitHubReactionContent } from '../../shared/types'

type GitHubGraphQLReactionContent =
  | 'THUMBS_UP'
  | 'THUMBS_DOWN'
  | 'LAUGH'
  | 'CONFUSED'
  | 'HEART'
  | 'HOORAY'
  | 'ROCKET'
  | 'EYES'

export type GitHubGraphQLReactionGroup = {
  content?: string | null
  reactors?: { totalCount?: number | null } | null
}

const GRAPHQL_REACTION_CONTENT: Record<GitHubGraphQLReactionContent, GitHubReactionContent> = {
  THUMBS_UP: '+1',
  THUMBS_DOWN: '-1',
  LAUGH: 'laugh',
  CONFUSED: 'confused',
  HEART: 'heart',
  HOORAY: 'hooray',
  ROCKET: 'rocket',
  EYES: 'eyes'
}

const REACTION_ORDER: GitHubReactionContent[] = [
  '+1',
  '-1',
  'laugh',
  'confused',
  'heart',
  'hooray',
  'rocket',
  'eyes'
]

export function mapGraphQLReactionGroups(
  groups?: GitHubGraphQLReactionGroup[] | null
): GitHubReaction[] | undefined {
  const counts = new Map<GitHubReactionContent, number>()
  for (const group of groups ?? []) {
    const content =
      group.content && group.content in GRAPHQL_REACTION_CONTENT
        ? GRAPHQL_REACTION_CONTENT[group.content as GitHubGraphQLReactionContent]
        : null
    const count = group.reactors?.totalCount ?? 0
    if (!content || count <= 0) {
      continue
    }
    counts.set(content, (counts.get(content) ?? 0) + count)
  }

  const reactions = REACTION_ORDER.flatMap((content) => {
    const count = counts.get(content) ?? 0
    return count > 0 ? [{ content, count }] : []
  })
  return reactions.length > 0 ? reactions : undefined
}
