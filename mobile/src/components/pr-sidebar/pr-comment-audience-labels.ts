import type { PRCommentAudienceFilter } from '../../../../src/shared/pr-comment-audience'

export const PR_COMMENT_AUDIENCE_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'human', label: 'Humans' },
  { value: 'bot', label: 'Bots' }
] satisfies { value: PRCommentAudienceFilter; label: string }[]

export function getPRCommentAudienceEmptyLabel(filter: PRCommentAudienceFilter): string {
  switch (filter) {
    case 'bot':
      return 'No bot comments.'
    case 'human':
      return 'No human comments.'
    case 'all':
      return 'No comments yet.'
  }
}
