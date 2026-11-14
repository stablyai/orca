import { useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { Search, X } from 'lucide-react-native'
import { colors, pressedStyle } from '../../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import type { Translate } from '../../../../i18n/mobile-i18n'
import type { GitHubWorkItemDetails } from '../../../../../../src/shared/github/work-items/work-item-types'
import { getGitHubPRReviewerRows } from '../../../../../../src/shared/github/pull-requests/pr-reviewer-display'
import { useCalmConnectionState } from '../../../../transport/connection/calm-connection-state'
import {
  classifyConnection,
  verdictDisplayLabel
} from '../../../../transport/connection/connection-health'
import { useReviewerPeople } from './use-reviewer-people'
import { SheetHeader } from '../../../../components/nav-bar/SheetHeader'
import { ListGroup, ListRow } from '../../../../components/list/ListGroup'
import { TextField } from '../../../../components/composer-input/TextField'
import { livePrDetails, readyPrData, type MobilePrTab } from '../use-mobile-pr-tab'
import type { PrTabSheetRequest } from '../pr-tab-requests'
import { prSheetStyles as sheetStyles } from '../pr-tab-styles'

function reviewerStateLabel(
  item: GitHubWorkItemDetails['item'],
  login: string,
  t: Translate
): { label: string; approved: boolean } {
  const normalized = login.toLowerCase()
  if (item.reviewRequests?.some((user) => user.login.trim().toLowerCase() === normalized)) {
    return { label: t('pullRequest.reviewersSection.requested', 'Requested'), approved: false }
  }
  const review = item.latestReviews?.find(
    (entry) => entry.login.trim().toLowerCase() === normalized
  )
  switch (review?.state) {
    case 'APPROVED':
      return { label: t('pullRequest.reviewersSection.approved', 'Approved'), approved: true }
    case 'CHANGES_REQUESTED':
      return {
        label: t('pullRequest.reviewersSection.changesRequested', 'Changes requested'),
        approved: false
      }
    case 'COMMENTED':
      return { label: t('pullRequest.reviewersSection.commented', 'Commented'), approved: false }
    case 'DISMISSED':
      return { label: t('pullRequest.reviewersSection.dismissed', 'Dismissed'), approved: false }
    case 'PENDING':
      return { label: t('pullRequest.reviewersSection.pending', 'Pending'), approved: false }
    default:
      return { label: t('pullRequest.reviewersSection.reviewed', 'Reviewed'), approved: false }
  }
}

// Reviewers with remove, and a search that requests a new one; same add/remove as the old section.
export function PrReviewersSheet({
  tab,
  request
}: {
  tab: MobilePrTab
  request: PrTabSheetRequest
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { actions, client, worktreeId } = tab
  const rawDetails = readyPrData(tab)?.details ?? null
  const details = livePrDetails(rawDetails)
  // A placeholder means the read failed; only null is still loading.
  const detailsFailed = rawDetails !== null && details === null
  const [query, setQuery] = useState('')
  const searching = query.trim().length > 0
  // Candidates belong to this open request's repository; closing or a PR departure ends their visit at once.
  const people = useReviewerPeople({
    hostId: tab.hostId,
    client,
    worktreeId,
    prRepo: readyPrData(tab)?.pr.prRepo ?? null,
    request: tab.sheetRequest === request ? request : null,
    search: searching
  })
  const { users, error } = people
  const { hostConnection, connState } = tab
  const presentedConnState = useCalmConnectionState(connState, hostConnection.lastConnectedAt)
  // Without candidates, an outage the calm presentation reveals explains the wait with the header's verdict.
  const connectionLabel =
    !users && !error && connState !== 'connected' && presentedConnState !== 'connected'
      ? verdictDisplayLabel(classifyConnection({ state: connState, ...hostConnection }))
      : null

  const rows = useMemo(
    () =>
      details
        ? getGitHubPRReviewerRows(details.item).map((row) => ({
            ...row,
            ...reviewerStateLabel(details.item, row.login, t)
          }))
        : [],
    [details, t]
  )
  const authoritative = useMemo(() => new Set(rows.map((r) => r.login.toLowerCase())), [rows])
  const isRequested = (login: string) =>
    actions.resolveReviewerRequested(login, authoritative.has(login.toLowerCase()))
  const visibleRows = rows.filter((row) => isRequested(row.login))
  // A click from an outgoing or departed presentation sends nothing.
  const requestReviewer = (login: string) => {
    if (tab.ownsSheet(request)) {
      actions.requestReviewer(login)
    }
  }
  const removeReviewer = (login: string) => {
    if (tab.ownsSheet(request)) {
      actions.removeReviewer(login)
    }
  }
  const approvals = rows.filter((row) => row.approved).length

  const matches = useMemo(() => {
    if (!users) {
      return []
    }
    const q = query.trim().toLowerCase()
    const author = details?.item.author?.toLowerCase()
    return users
      .filter((user) => user.login.toLowerCase() !== author)
      .filter(
        (user) =>
          user.login.toLowerCase().includes(q) || (user.name ?? '').toLowerCase().includes(q)
      )
      .slice(0, 20)
  }, [details, users, query])

  return (
    <View>
      <SheetHeader
        title={t('pullRequest.reviewersSection.title', 'Reviewers')}
        subtitle={
          approvals === 1
            ? t('pullRequest.reviewersSheet.approvals_one', '{{count}} approval', {
                count: approvals
              })
            : t('pullRequest.reviewersSheet.approvals_other', '{{count}} approvals', {
                count: approvals
              })
        }
        trailing={{ label: t('common.done', 'Done'), onPress: tab.closeSheet }}
      />
      <View style={sheetStyles.body}>
        <TextField
          leading={<Search size={16} color={colors.textMuted} />}
          value={query}
          onChangeText={setQuery}
          placeholder={t('pullRequest.reviewersSheet.addReviewer', 'Add a reviewer')}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {searching ? (
          users ? (
            matches.length > 0 ? (
              <ListGroup>
                {matches.map((user) => {
                  const requested = isRequested(user.login)
                  return (
                    <ListRow
                      key={user.login}
                      title={user.name ? `${user.name} (${user.login})` : user.login}
                      selected={requested}
                      busy={actions.isBusy({ kind: 'reviewer', login: user.login })}
                      onPress={() =>
                        requested ? removeReviewer(user.login) : requestReviewer(user.login)
                      }
                    />
                  )
                })}
              </ListGroup>
            ) : (
              <Text style={sheetStyles.note}>
                {t('pullRequest.reviewerPickerDrawer.noMatches', 'No matching people')}
              </Text>
            )
          ) : error ? (
            <Text style={sheetStyles.error}>
              {error.message ??
                t('pullRequest.reviewerPickerDrawer.loadFailed', 'Failed to load people')}
            </Text>
          ) : connectionLabel ? (
            <Text style={sheetStyles.note}>{connectionLabel}</Text>
          ) : (
            <ActivityIndicator color={colors.textSecondary} />
          )
        ) : !details ? (
          detailsFailed ? (
            <Text style={sheetStyles.error}>
              {t(
                'pullRequest.reviewersSection.loadFailed',
                'Could not load reviewers. Tap refresh to try again.'
              )}
            </Text>
          ) : (
            <ActivityIndicator color={colors.textSecondary} />
          )
        ) : visibleRows.length === 0 ? (
          <Text style={sheetStyles.note}>
            {t('pullRequest.reviewersSection.noReviewers', 'No reviewers requested')}
          </Text>
        ) : (
          <ListGroup>
            {visibleRows.map((row) => (
              <ListRow
                key={row.login}
                title={row.name ? `${row.name} (${row.login})` : row.login}
                detail={
                  <Text style={[sheetStyles.state, row.approved && sheetStyles.approved]}>
                    {row.label}
                  </Text>
                }
                accessory={
                  <Pressable
                    onPress={() => removeReviewer(row.login)}
                    disabled={actions.isBusy({ kind: 'reviewer', login: row.login })}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t(
                      'pullRequest.reviewersSection.removeReviewer',
                      'Remove {{login}}',
                      { login: row.login }
                    )}
                    style={({ pressed }) => pressed && pressedStyle}
                  >
                    {actions.isBusy({ kind: 'reviewer', login: row.login }) ? (
                      <ActivityIndicator size="small" color={colors.textMuted} />
                    ) : (
                      <X size={16} color={colors.textMuted} strokeWidth={2.2} />
                    )}
                  </Pressable>
                }
              />
            ))}
          </ListGroup>
        )}
        {actions.error ? <Text style={sheetStyles.error}>{actions.error}</Text> : null}
      </View>
    </View>
  )
}
