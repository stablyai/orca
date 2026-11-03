import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { Search, X } from 'lucide-react-native'
import { colors, pressedStyle } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { Translate } from '../../i18n/mobile-i18n'
import type { GitHubAssignableUser } from '../../../../src/shared/github/pull-request-types'
import type { GitHubWorkItemDetails } from '../../../../src/shared/github/work-item-types'
import { getGitHubPRReviewerRows } from '../../../../src/shared/github/pr-reviewer-display'
import { fetchAssignableUsers } from '../../session/github-pr-rpc'
import { SheetHeader } from '../nav-bar/SheetHeader'
import { ListGroup, ListRow } from '../list/ListGroup'
import { TextField } from '../composer-input/TextField'
import { livePrDetails, readyPrData, type MobilePrTab } from './use-mobile-pr-tab'
import { prSheetStyles as sheetStyles } from './pr-tab-styles'

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

type PeopleLoad =
  | { status: 'idle' | 'loading' }
  | { status: 'error'; message: string | null }
  | { status: 'loaded'; users: GitHubAssignableUser[] }

// Reviewers with remove, and a search that requests a new one; same add/remove as the old section.
export function PrReviewersSheet({ tab }: { tab: MobilePrTab }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { actions, client, worktreeId } = tab
  const rawDetails = readyPrData(tab)?.details ?? null
  const details = livePrDetails(rawDetails)
  // A placeholder means the read failed; only null is still loading.
  const detailsFailed = rawDetails !== null && details === null
  const [query, setQuery] = useState('')
  const [people, setPeople] = useState<PeopleLoad>({ status: 'idle' })
  const searching = query.trim().length > 0

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
  const approvals = rows.filter((row) => row.approved).length

  // Load people once, on the first search; the loading state must not re-run and cancel this read.
  const peopleRequestedRef = useRef(false)
  useEffect(() => {
    if (!searching || peopleRequestedRef.current || !client) {
      return
    }
    peopleRequestedRef.current = true
    setPeople({ status: 'loading' })
    void fetchAssignableUsers(client, worktreeId)
      .then((outcome) =>
        setPeople(
          outcome.ok
            ? { status: 'loaded', users: outcome.result }
            : { status: 'error', message: outcome.error }
        )
      )
      .catch(() => setPeople({ status: 'error', message: null }))
  }, [client, searching, worktreeId])

  const matches = useMemo(() => {
    if (people.status !== 'loaded') {
      return []
    }
    const q = query.trim().toLowerCase()
    const author = details?.item.author?.toLowerCase()
    return people.users
      .filter((user) => user.login.toLowerCase() !== author)
      .filter(
        (user) =>
          user.login.toLowerCase().includes(q) || (user.name ?? '').toLowerCase().includes(q)
      )
      .slice(0, 20)
  }, [details, people, query])

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
          people.status === 'loaded' ? (
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
                        requested
                          ? actions.removeReviewer(user.login)
                          : actions.requestReviewer(user.login)
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
          ) : people.status === 'error' ? (
            <Text style={sheetStyles.error}>
              {people.message ??
                t('pullRequest.reviewerPickerDrawer.loadFailed', 'Failed to load people')}
            </Text>
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
                    onPress={() => actions.removeReviewer(row.login)}
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
