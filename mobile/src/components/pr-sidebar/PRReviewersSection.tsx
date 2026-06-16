import { Text, View } from 'react-native'
import type { GitHubWorkItemDetails } from '../../../../src/shared/types'
import { getPRReviewerRows } from './pr-checks-presentation'
import { statusColor } from './pr-sidebar-status-color'
import { mobilePrSidebarStyles as styles } from './mobile-pr-sidebar-styles'

type Props = {
  details: GitHubWorkItemDetails | null
}

// Requested reviewers + their latest review status. Display-only (the add/remove
// picker is U6).
export function PRReviewersSection({ details }: Props) {
  const rows = details?.item ? getPRReviewerRows(details.item) : []
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>Reviewers</Text>
      {rows.length === 0 ? (
        <Text style={styles.emptyText}>No reviewers requested</Text>
      ) : (
        rows.map((row) => (
          <View key={row.login} style={styles.row}>
            <View style={styles.rowMain}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {row.name ? `${row.name} (${row.login})` : row.login}
              </Text>
            </View>
            <Text style={[styles.rowStatus, { color: statusColor(row.token) }]}>
              {row.stateLabel}
            </Text>
          </View>
        ))
      )}
    </View>
  )
}
