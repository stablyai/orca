import { t } from '../i18n/mobile-i18n'

export function githubReviewStateLabel(state: string | null | undefined): string {
  switch (state) {
    case 'APPROVED':
      return t('prChecksPresentation.approved')
    case 'CHANGES_REQUESTED':
      return t('prChecksPresentation.changes')
    case 'COMMENTED':
      return t('prChecksPresentation.commented')
    case 'DISMISSED':
      return t('prChecksPresentation.dismissed')
    case 'PENDING':
      return t('prChecksPresentation.pending')
    default:
      return t('prChecksPresentation.reviewed')
  }
}

export function githubPullRequestDelta(item: {
  additions?: number
  deletions?: number
  changedFiles?: number
}): string | null {
  const parts: string[] = []
  if (typeof item.additions === 'number') {
    parts.push(`+${item.additions}`)
  }
  if (typeof item.deletions === 'number') {
    parts.push(`-${item.deletions}`)
  }
  if (typeof item.changedFiles === 'number') {
    parts.push(
      t(item.changedFiles === 1 ? 'review.changedFiles.one' : 'review.changedFiles.other', {
        count: item.changedFiles
      })
    )
  }
  return parts.length > 0 ? parts.join(' ') : null
}
