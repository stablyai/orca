import { Text, View } from 'react-native'
import { ArrowLeft } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import type { GitHubWorkItemDetails, PRInfo } from '../../../../src/shared/types'
import { prStateBadge } from './pr-checks-presentation'
import { statusColor } from './pr-sidebar-status-color'
import { mobilePrSidebarStyles as styles } from './mobile-pr-sidebar-styles'

type Props = {
  pr: PRInfo
  details: GitHubWorkItemDetails | null
}

// Header: state badge (incl. draft — display-only), title, author, base<-head.
export function PRSidebarHeader({ pr, details }: Props) {
  const item = details?.item
  const badge = prStateBadge(pr.state)
  const badgeColor = statusColor(badge.token)
  const title = item?.title ?? pr.title
  const author = item?.author ?? null
  const baseRef = item?.baseRefName ?? null
  const headRef = item?.branchName ?? null

  return (
    <View style={styles.section}>
      <View style={[styles.badge, { borderColor: badgeColor }]}>
        <Text style={[styles.badgeText, { color: badgeColor }]}>{badge.label}</Text>
      </View>
      <Text style={styles.prTitle}>
        {title} <Text style={styles.prMeta}>#{pr.number}</Text>
      </Text>
      {author ? <Text style={styles.prMeta}>by {author}</Text> : null}
      {baseRef && headRef ? (
        <View style={styles.branchRow}>
          <Text style={styles.branchPill}>{baseRef}</Text>
          <ArrowLeft size={12} color={colors.textSecondary} strokeWidth={2.2} />
          <Text style={styles.branchPill}>{headRef}</Text>
        </View>
      ) : null}
    </View>
  )
}
