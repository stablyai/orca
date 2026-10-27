import { useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { UserPlus, X } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import type { GitHubWorkItemDetails } from '../../../../src/shared/github/work-item-types'
import type { RpcClient } from '../../transport/rpc-client'
import type { MobilePrActions } from '../../session/use-mobile-pr-actions'
import { isPrSidebarDetailsPlaceholder } from '../../session/mobile-pr-sidebar-state'
import { getGitHubPRReviewerRows } from '../../../../src/shared/github/pr-reviewer-display'
import { ReviewerPickerDrawer } from './ReviewerPickerDrawer'
import { PRSection } from './PRSection'
import { mobilePrSidebarStyles as styles } from './mobile-pr-sidebar-styles'

type Props = {
  details: GitHubWorkItemDetails | null
  actions: MobilePrActions
  client: RpcClient | null
  worktreeId: string
}

// Requested reviewers/latest verdicts with optimistic request/remove picker.
export function PRReviewersSection({ details, actions, client, worktreeId }: Props) {
  // Null details means heavy phase 2 still loading; synthetic placeholder means failure, neither means no reviewers.
  const loadingDetails = details === null
  const detailsFailed = details != null && isPrSidebarDetailsPlaceholder(details)
  const authoritativeRows = useMemo(
    () =>
      details?.item && !isPrSidebarDetailsPlaceholder(details)
        ? getGitHubPRReviewerRows(details.item)
        : [],
    [details]
  )
  const [pickerOpen, setPickerOpen] = useState(false)

  // Resolve optimism against authoritative request set; newly added login may have no fetched row yet.
  const authoritativeRequested = useMemo(
    () => new Set(authoritativeRows.map((r) => r.login.toLowerCase())),
    [authoritativeRows]
  )
  const isRequested = (login: string): boolean =>
    actions.resolveReviewerRequested(login, authoritativeRequested.has(login.toLowerCase()))

  // Filter authoritative rows by optimistic membership; new login appears after refetch, while picker check updates immediately.
  const rows = authoritativeRows.filter((r) => isRequested(r.login))

  const seededLogins = useMemo(() => {
    const logins = authoritativeRows.map((r) => r.login)
    const author = details?.item?.author
    return author ? [author, ...logins] : logins
  }, [authoritativeRows, details])

  const addButton = (
    <Pressable
      style={styles.iconButton}
      onPress={() => setPickerOpen(true)}
      accessibilityRole="button"
      accessibilityLabel="Add or remove reviewers"
    >
      <UserPlus size={16} color={colors.textSecondary} strokeWidth={2.2} />
    </Pressable>
  )

  return (
    <PRSection title="Reviewers" trailing={addButton}>
      {loadingDetails ? (
        <View style={styles.reviewersStatus}>
          <ActivityIndicator color={colors.textSecondary} />
          <Text style={styles.emptyText}>Loading reviewers…</Text>
        </View>
      ) : detailsFailed ? (
        <Text style={styles.emptyText}>Could not load reviewers. Tap refresh to try again.</Text>
      ) : rows.length === 0 ? (
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
              {/* Use neutral desktop tone; label text carries review state. */}
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
