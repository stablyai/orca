import { useEffect, useMemo, useState } from 'react'
import { View } from 'react-native'
import { AlertCircle, Users } from 'lucide-react-native'
import type { GitHubAssignableUser } from '../../../../src/shared/github/pull-request-types'
import type { RpcClient } from '../../transport/rpc-client'
import { fetchAssignableUsers } from '../../session/github-pr-rpc'
import { BottomDrawer } from '../BottomDrawer'
import { MobileSearchField } from '../MobileSearchField'
import { ListGroup, LIST_LEADING_INSET } from '../ui/ListGroup'
import { ListRow } from '../ui/ListRow'
import { SheetHeader } from '../ui/SheetHeader'
import { StateView } from '../ui/StateView'
import { triggerSelection } from '../../platform/haptics'
import { PRAvatar } from './PRAvatar'
import { mobilePrSidebarStyles as styles } from './mobile-pr-sidebar-styles'

type Props = {
  visible: boolean
  onClose: () => void
  client: RpcClient | null
  worktreeId: string
  // Logins already requested/reviewing (+ author) — surfaced at the top of the list.
  seededLogins: string[]
  // Resolves the optimistic requested-state for a login (so a just-toggled row reflects it).
  isRequested: (login: string) => boolean
  onToggle: (login: string) => void
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; users: GitHubAssignableUser[] }

// Searchable assignable-user list in a BottomDrawer. Mapped rows (not FlatList):
// this drawer is opened from the PR ScrollView, and a VirtualizedList nested in
// that ScrollView throws and can leave the Reviewers section blank.
// Seeded reviewers + author sort first for quick un-request.
export function ReviewerPickerDrawer({
  visible,
  onClose,
  client,
  worktreeId,
  seededLogins,
  isRequested,
  onToggle
}: Props) {
  const [load, setLoad] = useState<LoadState>({ status: 'idle' })
  const [query, setQuery] = useState('')
  const [reloadNonce, setReloadNonce] = useState(0)

  useEffect(() => {
    if (!visible || !client) {
      return
    }
    let cancelled = false
    setLoad({ status: 'loading' })
    void fetchAssignableUsers(client, worktreeId)
      .then((outcome) => {
        if (cancelled) {
          return
        }
        setLoad(
          outcome.ok
            ? { status: 'loaded', users: outcome.result }
            : { status: 'error', message: outcome.error }
        )
      })
      .catch(() => {
        if (!cancelled) {
          setLoad({ status: 'error', message: 'Failed to load people' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [visible, client, worktreeId, reloadNonce])

  const ordered = useMemo(() => {
    if (load.status !== 'loaded') {
      return []
    }
    const seed = new Set(seededLogins.map((l) => l.toLowerCase()))
    // Seeded reviewers sort first so the user can quickly un-request them.
    const sorted = [...load.users].sort((a, b) => {
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
  }, [load, seededLogins, query])

  return (
    <BottomDrawer visible={visible} onClose={onClose} dragContentToDismiss={false}>
      <SheetHeader title="Reviewers" trailing={{ label: 'Done', onPress: onClose }} />
      <View style={styles.pickerSearch}>
        <MobileSearchField value={query} onChangeText={setQuery} placeholder="Search people" />
      </View>
      {load.status === 'loading' || load.status === 'idle' ? (
        <View style={styles.pickerState}>
          <StateView loading title="Loading people…" />
        </View>
      ) : load.status === 'error' ? (
        <View style={styles.pickerState}>
          <StateView
            icon={AlertCircle}
            title="Couldn't load people"
            message={load.message}
            primary={{ label: 'Retry', onPress: () => setReloadNonce((n) => n + 1) }}
          />
        </View>
      ) : ordered.length === 0 ? (
        <View style={styles.pickerState}>
          <StateView
            icon={Users}
            title="No matching people"
            message={query.trim() ? 'Try a name or a GitHub login.' : undefined}
          />
        </View>
      ) : (
        <ListGroup style={styles.pickerList} separatorInset={LIST_LEADING_INSET}>
          {ordered.map((item) => {
            const requested = isRequested(item.login)
            return (
              <ListRow
                key={item.login}
                title={item.name ?? item.login}
                subtitle={item.name ? item.login : undefined}
                leading={<PRAvatar login={item.login} url={item.avatarUrl} />}
                selected={requested}
                onPress={() => {
                  triggerSelection()
                  onToggle(item.login)
                }}
                accessibilityRole="button"
                accessibilityLabel={`${requested ? 'Remove' : 'Request'} ${item.login}`}
              />
            )
          })}
        </ListGroup>
      )}
    </BottomDrawer>
  )
}
