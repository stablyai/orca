import type { PRCommentAudienceFilter } from '../../../../src/shared/pr-comment-audience'
import { translate } from '../../i18n/mobile-i18n'

export const PR_COMMENT_AUDIENCE_FILTERS = [
  {
    value: 'all',
    get label() {
      return translate('pullRequest.prCommentAudienceLabels.all', 'All')
    }
  },
  {
    value: 'human',
    get label() {
      return translate('pullRequest.prCommentAudienceLabels.humans', 'Humans')
    }
  },
  {
    value: 'bot',
    get label() {
      return translate('pullRequest.prCommentAudienceLabels.bots', 'Bots')
    }
  }
] satisfies { value: PRCommentAudienceFilter; label: string }[]

export function getPRCommentAudienceEmptyLabel(filter: PRCommentAudienceFilter): string {
  switch (filter) {
    case 'bot':
      return translate('pullRequest.prCommentAudienceLabels.noBotComments', 'No bot comments.')
    case 'human':
      return translate('pullRequest.prCommentAudienceLabels.noHumanComments', 'No human comments.')
    case 'all':
      return translate('pullRequest.prCommentAudienceLabels.noComments', 'No comments yet.')
  }
}
