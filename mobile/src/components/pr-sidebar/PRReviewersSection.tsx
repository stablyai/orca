import { useMemo, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { UserPlus, X } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { ListRow } from '../ui/ListRow'
import { PRAvatar } from './PRAvatar'
import type { GitHubWorkItemDetails } from '../../../../src/shared/github/work-item-types'
import type { RpcClient } from '../../transport/rpc-client'
import type { MobilePrActions } from '../../session/use-mobile-pr-actions'
import { isPrSidebarDetailsPlaceholder } from '../../session/mobile-pr-sidebar-state'
import { getPRReviewerRows } from './pr-checks-presentation'
import { ReviewerPickerDrawer } from './ReviewerPickerDrawer'
import { PRSection } from './PRSection'
import { mobilePrSidebarStyles as styles } from './mobile-pr-sidebar-styles'

type Props = {
  details: GitHubWorkItemDetails | null
  actions: MobilePrActions
  client: RpcClient | null
  worktreeId: string
  // Re-fetches the PR when its details failed to load.
  onRetry?: () => void
}

// Requested reviewers + their latest review status, with a picker to request /
// remove (optimistic add/remove via the actions hook).
export function PRReviewersSection({ details, actions, client, worktreeId, onRetry }: Props) {
  // details === null means phase 2 (work-item payload) is still in flight — same
  // signal Comments uses. Do not treat that as "no reviewers" or the section goes
  // blank while checks (phase 1) already paint. A synthetic placeholder means
  // phase 2 failed (no body/comments/reviews landed).
  const loadingDetails = details === null
  const detailsFailed = details != null && isPrSidebarDetailsPlaceholder(details)
  const authoritativeRows = useMemo(
    () =>
      details?.item && !isPrSidebarDetailsPlaceholder(details)
        ? getPRReviewerRows(details.item)
        : [],
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

  const addButton = (
    <Button
      label="Add"
      icon={UserPlus}
      variant="plain"
      size="compact"
      onPress={() => setPickerOpen(true)}
      accessibilityLabel="Add or remove reviewers"
    />
  )

  return (
    <>
      <PRSection
        title="Reviewers"
        count={rows.length > 0 ? rows.length : undefined}
        trailing={addButton}
        layout="rows"
      >
        {loadingDetails ? (
          <View style={styles.noteRow}>
            <ActivityIndicator color={colors.textSecondary} />
            <Text style={styles.noteRowText}>Loading reviewers…</Text>
          </View>
        ) : detailsFailed ? (
          <View style={styles.noteRow}>
            <Text style={styles.noteRowText}>Couldn't load reviewers.</Text>
            {onRetry ? <Button label="Retry" size="compact" onPress={onRetry} /> : null}
          </View>
        ) : rows.length === 0 ? (
          <View style={styles.noteRow}>
            <Text style={styles.noteRowText}>No reviewers requested.</Text>
          </View>
        ) : (
          rows.map((row) => {
            const busy = actions.isBusy({ kind: 'reviewer', login: row.login })
            return (
              <ListRow
                key={row.login}
                title={row.name ?? row.login}
                // The state rides the second line so a long name keeps the full row width.
                subtitle={row.name ? `${row.login} · ${row.stateLabel}` : row.stateLabel}
                leading={<PRAvatar login={row.login} url={row.avatarUrl} />}
                accessory={
                  busy ? (
                    <View style={styles.rowSpinner}>
                      <ActivityIndicator color={colors.textSecondary} />
                    </View>
                  ) : (
                    <IconButton
                      icon={X}
                      variant="bare"
                      iconSize={16}
                      iconColor={colors.textMuted}
                      onPress={() => actions.removeReviewer(row.login)}
                      accessibilityLabel={`Remove ${row.login}`}
                    />
                  )
                }
              />
            )
          })
        )}
      </PRSection>
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
    </>
  )
}
