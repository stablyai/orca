import { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { GitPullRequest, Link2 } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { normalizeHostedReviewHeadRef } from '../../../../src/shared/hosted-review-refs'
import { fetchWorktreeGitHubPRLink } from '../../source-control/mobile-pr-link'
import { ListGroup, ListRow } from '../list/ListGroup'
import { MobileLinkPrForm } from './MobileLinkPrForm'
import type { MobilePrTab } from './use-mobile-pr-tab'
import { prTabStyles as styles } from './pr-tab-styles'

type Props = {
  tab: MobilePrTab
  branchCompare: { commitsAhead?: number; baseRef: string } | null
}

// No PR yet: say what is ready to go; the bottom action creates, linking stays the quiet way out.
export function PrTabEmptyState({ tab, branchCompare }: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { client, worktreeId } = tab
  const gitBranch = tab.gitBranch ? normalizeHostedReviewHeadRef(tab.gitBranch) : null
  const [linking, setLinking] = useState(false)
  // A persisted link whose PR no longer resolves gets named, so the user knows why it vanished.
  const [orphanLinkedPR, setOrphanLinkedPR] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!client) {
      setOrphanLinkedPR(null)
      return
    }
    void fetchWorktreeGitHubPRLink(client, worktreeId)
      .then((link) => {
        if (!cancelled) {
          setOrphanLinkedPR(link.linkedPR)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOrphanLinkedPR(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, worktreeId])

  if (linking) {
    return (
      <MobileLinkPrForm
        client={client}
        worktreeId={worktreeId}
        onCancel={() => setLinking(false)}
        onLinked={() => {
          setLinking(false)
          tab.refetch()
        }}
      />
    )
  }

  const commits = branchCompare?.commitsAhead
  const body = orphanLinkedPR
    ? t(
        'pullRequest.prSidebarCreateEmptyState.refreshOrCreate',
        'Refresh to check again, or create a new PR for this branch.'
      )
    : gitBranch && branchCompare && commits !== undefined && commits > 0
      ? commits === 1
        ? t(
            'pullRequest.emptyState.commitsReady_one',
            '{{count}} commit on {{branch}} is ready to go into {{base}}.',
            { count: commits, branch: gitBranch, base: branchCompare.baseRef }
          )
        : t(
            'pullRequest.emptyState.commitsReady_other',
            '{{count}} commits on {{branch}} are ready to go into {{base}}.',
            { count: commits, branch: gitBranch, base: branchCompare.baseRef }
          )
      : gitBranch
        ? t(
            'pullRequest.prSidebarCreateEmptyState.branchNotLinked',
            '{{branch}} is not linked to an open PR.',
            { branch: gitBranch }
          )
        : t(
            'pullRequest.prSidebarCreateEmptyState.currentBranchNotLinked',
            'The current branch is not linked to an open PR.'
          )
  return (
    <>
      <View style={styles.empty}>
        <GitPullRequest size={28} color={colors.textMuted} strokeWidth={1.6} />
        <Text style={styles.emptyTitle}>
          {orphanLinkedPR
            ? t(
                'pullRequest.prSidebarCreateEmptyState.linkedPrUnavailable',
                'Linked PR #{{number}} unavailable',
                { number: orphanLinkedPR }
              )
            : t('pullRequest.emptyState.title', 'No pull request yet')}
        </Text>
        <Text style={styles.emptyBody}>{body}</Text>
      </View>
      <ListGroup>
        <ListRow
          key="link"
          title={t(
            'pullRequest.prSidebarCreateEmptyState.linkExistingPullRequest',
            'Link an existing pull request'
          )}
          leading={<Link2 size={18} color={colors.textSecondary} strokeWidth={2} />}
          navigates
          disabled={!client}
          onPress={() => setLinking(true)}
        />
      </ListGroup>
    </>
  )
}
