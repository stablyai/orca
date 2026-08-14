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
  viewerHasReacted?: boolean | null
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

const REACTION_CONTENT_TO_GRAPHQL: Record<GitHubReactionContent, GitHubGraphQLReactionContent> = {
  '+1': 'THUMBS_UP',
  '-1': 'THUMBS_DOWN',
  laugh: 'LAUGH',
  confused: 'CONFUSED',
  heart: 'HEART',
  hooray: 'HOORAY',
  rocket: 'ROCKET',
  eyes: 'EYES'
}

export function toGraphQLReactionContent(
  content: GitHubReactionContent
): GitHubGraphQLReactionContent {
  return REACTION_CONTENT_TO_GRAPHQL[content]
}

export function mapGraphQLReactionGroups(
  groups?: GitHubGraphQLReactionGroup[] | null
): GitHubReaction[] | undefined {
  const reactionsByContent = new Map<GitHubReactionContent, GitHubReaction>()
  for (const group of groups ?? []) {
    const content =
      group.content && group.content in GRAPHQL_REACTION_CONTENT
        ? GRAPHQL_REACTION_CONTENT[group.content as GitHubGraphQLReactionContent]
        : null
    const count = group.reactors?.totalCount ?? 0
    if (!content || count <= 0) {
      continue
    }
    const existing = reactionsByContent.get(content)
    const viewerHasReacted = Boolean(existing?.viewerHasReacted || group.viewerHasReacted)
    reactionsByContent.set(content, {
      content,
      count: (existing?.count ?? 0) + count,
      ...(existing?.viewerHasReacted !== undefined || group.viewerHasReacted != null
        ? { viewerHasReacted }
        : {})
    })
  }

  const reactions = REACTION_ORDER.flatMap((content) => {
    const reaction = reactionsByContent.get(content)
    return reaction ? [reaction] : []
  })
  return reactions.length > 0 ? reactions : undefined
}
