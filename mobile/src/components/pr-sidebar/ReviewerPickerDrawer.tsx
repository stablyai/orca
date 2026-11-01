import { githubRepoIdentityKey } from '../../../../src/shared/github/repository-identity-key'
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { Check, Search } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type {
  GitHubAssignableUser,
  GitHubOwnerRepo
} from '../../../../src/shared/github/pull-request-types'
import type { RpcClient } from '../../transport/rpc-client'
import type { ConnectionState } from '../../transport/types'
import { useCalmConnectionState } from '../../transport/calm-connection-state'
import { classifyConnection, verdictDisplayLabel } from '../../transport/connection-health'
import { fetchAssignableUsers } from '../../session/github-pr-rpc'
import { BottomDrawer } from '../BottomDrawer'
import { TextField } from '../composer-input/TextField'
import { mobilePrSidebarStyles as styles } from './mobile-pr-sidebar-styles'

type Props = {
  visible: boolean
  onClose: () => void
  client: RpcClient | null
  prRepo: GitHubOwnerRepo | null
  worktreeId: string
  // Logins already requested/reviewing (+ author) — surfaced at the top of the list.
  seededLogins: string[]
  // Resolves the optimistic requested-state for a login (so a just-toggled row reflects it).
  isRequested: (login: string) => boolean
  onToggle: (login: string) => void
}

type PickerSnapshot = {
  // Undefined until this visit accepts a reply; [] is an accepted empty list.
  users: GitHubAssignableUser[] | undefined
  error: { message: string | null } | null
  connection: { state: ConnectionState; lastConnectedAt: number | null; reconnectAttempts: number }
}

// One open drawer for one client/worktree/repository; closing or retargeting starts a new visit.
type PickerVisit = {
  client: RpcClient | null
  worktreeId: string
  prRepo: GitHubOwnerRepo | null
  targetKey: string | null
  open: boolean
  live: boolean
  attempt: number
  observed: { state: ConnectionState; generation: number | undefined } | null
  latest: PickerSnapshot
}

function createPickerVisit(args: {
  client: RpcClient | null
  worktreeId: string
  prRepo: GitHubOwnerRepo | null
  targetKey: string | null
  open: boolean
}): PickerVisit {
  return {
    ...args,
    live: false,
    attempt: 0,
    observed: null,
    latest: {
      users: undefined,
      error: null,
      connection: {
        state: args.client?.getState() ?? 'disconnected',
        lastConnectedAt: args.client?.getLastConnectedAt() ?? null,
        reconnectAttempts: args.client?.getReconnectAttempt() ?? 0
      }
    }
  }
}

// Use mapped rows: VirtualizedList nested in PR ScrollView throws and can blank section. Seed reviewers/author first for easy unrequest.
export function ReviewerPickerDrawer({
  visible,
  onClose,
  client,
  worktreeId,
  prRepo,
  seededLogins,
  isRequested,
  onToggle
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [query, setQuery] = useState('')

  const targetKey = prRepo ? githubRepoIdentityKey(prRepo) : null
  const target = { client, worktreeId, prRepo, targetKey, open: visible }
  const [selection, setSelection] = useState(() => {
    const visit = createPickerVisit(target)
    return { visit, snapshot: visit.latest }
  })
  let selected = selection
  if (
    selection.visit.client !== client ||
    selection.visit.worktreeId !== worktreeId ||
    selection.visit.targetKey !== targetKey ||
    selection.visit.open !== visible
  ) {
    const visit = createPickerVisit(target)
    selected = { visit, snapshot: visit.latest }
    setSelection(selected)
  }
  const { visit, snapshot } = selected

  useLayoutEffect(() => {
    visit.live = true
    return () => {
      visit.live = false
      visit.attempt += 1
    }
  }, [visit])

  useEffect(() => {
    const visitClient = visit.client
    if (!visit.open || !visitClient) {
      return
    }
    const publish = (patch: Partial<PickerSnapshot>) => {
      const next = { ...visit.latest, ...patch }
      visit.latest = next
      setSelection((current) => (current.visit === visit ? { visit, snapshot: next } : current))
    }
    // Every real state or generation change retires the active attempt before the notification returns;
    // accepted rows stay, and a connected session starts the one attempt allowed to publish.
    const reconcile = (state: ConnectionState) => {
      if (!visit.live) {
        return
      }
      const generation = visitClient.getGeneration?.()
      const connection = {
        state,
        lastConnectedAt: visitClient.getLastConnectedAt(),
        reconnectAttempts: visitClient.getReconnectAttempt()
      }
      const observed = visit.observed
      if (observed?.state === state && Object.is(observed.generation, generation)) {
        publish({ connection })
        return
      }
      visit.observed = { state, generation }
      const attempt = ++visit.attempt
      publish({ connection, error: null })
      if (state !== 'connected') {
        return
      }
      const owns = () => visit.live && visit.attempt === attempt
      void fetchAssignableUsers(visitClient, visit.worktreeId, visit.prRepo).then(
        (outcome) => {
          if (!owns()) {
            return
          }
          if (outcome.ok) {
            publish({ users: outcome.result, error: null })
          } else if (!visit.latest.users) {
            publish({ error: { message: outcome.error } })
          }
        },
        () => {
          if (owns() && !visit.latest.users) {
            publish({ error: { message: null } })
          }
        }
      )
    }
    const stop = visitClient.onStateChange(reconcile)
    reconcile(visitClient.getState())
    return () => {
      stop()
      // A resubscription of this visit reconciles from scratch rather than matching a retired attempt.
      visit.observed = null
      visit.attempt += 1
    }
  }, [visit])

  const { users, error, connection } = snapshot
  const presentedConnState = useCalmConnectionState(connection.state, connection.lastConnectedAt)
  // Without rows, an outage the calm presentation reveals explains the wait instead of a spinner.
  const connectionLabel =
    !users && !error && connection.state !== 'connected' && presentedConnState !== 'connected'
      ? verdictDisplayLabel(classifyConnection(connection))
      : null

  const ordered = useMemo(() => {
    if (!users) {
      return []
    }
    const seed = new Set(seededLogins.map((l) => l.toLowerCase()))
    const sorted = [...users].sort((a, b) => {
      const aSeed = seed.has(a.login.toLowerCase()) ? 0 : 1
      const bSeed = seed.has(b.login.toLowerCase()) ? 0 : 1
      return aSeed - bSeed || a.login.localeCompare(b.login)
    })
    const q = query.trim().toLowerCase()
    if (!q) {
      return sorted
    }
    return sorted.filter(
      (u) => u.login.toLowerCase().includes(q) || (u.name ?? '').toLowerCase().includes(q)
    )
  }, [users, seededLogins, query])

  return (
    <BottomDrawer visible={visible} onClose={onClose} dragContentToDismiss={false}>
      <Text style={styles.pickerTitle}>
        {t('pullRequest.reviewerPickerDrawer.title', 'Reviewers')}
      </Text>
      <TextField
        style={styles.pickerSearch}
        leading={<Search size={16} color={colors.textMuted} />}
        value={query}
        onChangeText={setQuery}
        placeholder={t('pullRequest.reviewerPickerDrawer.searchPeople', 'Search people')}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {!users ? (
        <View style={styles.pickerStateArea}>
          {error ? (
            <Text style={styles.emptyText}>
              {error.message ??
                t('pullRequest.reviewerPickerDrawer.loadFailed', 'Failed to load people')}
            </Text>
          ) : connectionLabel ? (
            <Text style={styles.emptyText}>{connectionLabel}</Text>
          ) : (
            <ActivityIndicator color={colors.textSecondary} />
          )}
        </View>
      ) : ordered.length === 0 ? (
        <View style={styles.pickerStateArea}>
          <Text style={styles.emptyText}>
            {t('pullRequest.reviewerPickerDrawer.noMatches', 'No matching people')}
          </Text>
        </View>
      ) : (
        <View style={styles.pickerList}>
          {ordered.map((item) => {
            const requested = isRequested(item.login)
            return (
              <Pressable
                key={item.login}
                style={styles.pickerRow}
                onPress={() => onToggle(item.login)}
                accessibilityRole="button"
                accessibilityState={{ selected: requested }}
                accessibilityLabel={
                  requested
                    ? t('pullRequest.reviewerPickerDrawer.removeReviewer', 'Remove {{login}}', {
                        login: item.login
                      })
                    : t('pullRequest.reviewerPickerDrawer.requestReviewer', 'Request {{login}}', {
                        login: item.login
                      })
                }
              >
                <View style={styles.rowTrailing}>
                  {requested ? (
                    <Check size={16} color={colors.textPrimary} strokeWidth={2.4} />
                  ) : null}
                </View>
                <View style={styles.pickerRowMain}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {item.name ? `${item.name} (${item.login})` : item.login}
                  </Text>
                </View>
              </Pressable>
            )
          })}
        </View>
      )}
    </BottomDrawer>
  )
}
