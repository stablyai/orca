import { useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { UserPlus, X } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import type { GitHubWorkItemDetails } from '../../../../src/shared/types'
import type { RpcClient } from '../../transport/rpc-client'
import type { MobilePrActions } from '../../session/use-mobile-pr-actions'
import { getPRReviewerRows } from './pr-checks-presentation'
import { ReviewerPickerDrawer } from './ReviewerPickerDrawer'
import { PRSection } from './PRSection'
import { mobilePrSidebarStyles as styles } from './mobile-pr-sidebar-styles'

type Props = {
  details: GitHubWorkItemDetails | null
  actions: MobilePrActions
  client: RpcClient | null
  worktreeId: string
}

// Requested reviewers + their latest review status, with a picker to request /
// remove (optimistic add/remove via the actions hook).
export function PRReviewersSection({ details, actions, client, worktreeId }: Props) {
  const authoritativeRows = useMemo(
    () => (details?.item ? getPRReviewerRows(details.item) : []),
    [details]
  )
  const [pickerOpen, setPickerOpen] = useState(false)

  // The authoritative requested-set drives optimistic resolution; an optimistic
  // add can surface a login not yet in authoritativeRows.
  const authoritativeRequested = useMemo(
    () => new Set(authoritativeRows.map((r) => r.login.toLowerCase())),
    [authoritativeRows]
  )
  const isRequested = (login: string): boolean =>
    actions.resolveReviewerRequested(login, authoritativeRequested.has(login.toLowerCase()))

  // Render rows = authoritative rows whose optimistic membership is still true.
  // An optimistic add of a brand-new login surfaces in the row list only after
  // refetch supplies it authoritatively; until then the picker's check reflects it.
  const rows = authoritativeRows.filter((r) => isRequested(r.login))

  const seededLogins = useMemo(() => {
    const logins = authoritativeRows.map((r) => r.login)
    const author = details?.item?.author
    return author ? [author, ...logins] : logins
  }, [authoritativeRows, details])

  return (
    <PRSection
      title="Reviewers"
      trailing={
        <Pressable
          style={styles.iconButton}
          onPress={() => setPickerOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Add or remove reviewers"
        >
          <UserPlus size={16} color={colors.textSecondary} strokeWidth={2.2} />
        </Pressable>
      }
    >
      {rows.length === 0 ? (
        <Text style={styles.emptyText}>No reviewers requested</Text>
      ) : (
        rows.map((row) => {
          const busy = actions.isBusy({ kind: 'reviewer', login: row.login })
          return (
            <View key={row.login} style={styles.row}>
              <View style={styles.rowMain}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {row.name ? `${row.name} (${row.login})` : row.login}
                </Text>
              </View>
              {/* Neutral gray like the desktop PR page (the label text carries the
                  state); keeps the sidebar mostly monochrome. */}
              <Text style={[styles.rowStatus, { color: colors.textSecondary }]}>
                {row.stateLabel}
              </Text>
              <Pressable
                style={styles.rowTrailing}
                onPress={() => actions.removeReviewer(row.login)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${row.login}`}
              >
                {busy ? (
                  <ActivityIndicator color={colors.textSecondary} />
                ) : (
                  <X size={14} color={colors.textSecondary} strokeWidth={2.2} />
                )}
              </Pressable>
            </View>
          )
        })
      )}
      <ReviewerPickerDrawer
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        client={client}
        worktreeId={worktreeId}
        seededLogins={seededLogins}
        isRequested={isRequested}
        onToggle={(login) => {
          if (isRequested(login)) {
            actions.removeReviewer(login)
          } else {
            actions.requestReviewer(login)
          }
        }}
      />
    </PRSection>
  )
}
