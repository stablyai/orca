import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native'
import { Check } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import type { GitHubAssignableUser } from '../../../../src/shared/types'
import type { RpcClient } from '../../transport/rpc-client'
import { fetchAssignableUsers } from '../../session/github-pr-rpc'
import { BottomDrawer } from '../BottomDrawer'
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

// A search + FlatList of github.listAssignableUsers in a BottomDrawer (not a new
// primitive). Seeded with already-requested/latest reviewers + author at the top.
// Optimistic add/remove via onToggle.
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

  useEffect(() => {
    if (!visible || !client) {
      return
    }
    let cancelled = false
    setLoad({ status: 'loading' })
    void fetchAssignableUsers(client, worktreeId).then((outcome) => {
      if (cancelled) {
        return
      }
      setLoad(
        outcome.ok
          ? { status: 'loaded', users: outcome.result }
          : { status: 'error', message: outcome.error }
      )
    })
    return () => {
      cancelled = true
    }
  }, [visible, client, worktreeId])

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
      <Text style={styles.pickerTitle}>Reviewers</Text>
      <TextInput
        style={styles.pickerSearch}
        value={query}
        onChangeText={setQuery}
        placeholder="Search people"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {load.status === 'loading' ? (
        <View style={styles.pickerStateArea}>
          <ActivityIndicator color={colors.accentBlue} />
        </View>
      ) : load.status === 'error' ? (
        <View style={styles.pickerStateArea}>
          <Text style={styles.emptyText}>{load.message}</Text>
        </View>
      ) : ordered.length === 0 ? (
        <View style={styles.pickerStateArea}>
          <Text style={styles.emptyText}>No matching people</Text>
        </View>
      ) : (
        <FlatList
          style={styles.pickerList}
          data={ordered}
          keyExtractor={(u) => u.login}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            const requested = isRequested(item.login)
            return (
              <Pressable
                style={styles.pickerRow}
                onPress={() => onToggle(item.login)}
                accessibilityRole="button"
                accessibilityState={{ selected: requested }}
                accessibilityLabel={`${requested ? 'Remove' : 'Request'} ${item.login}`}
              >
                <View style={styles.rowTrailing}>
                  {requested ? (
                    <Check size={16} color={colors.statusGreen} strokeWidth={2.4} />
                  ) : null}
                </View>
                <View style={styles.pickerRowMain}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {item.name ? `${item.name} (${item.login})` : item.login}
                  </Text>
                </View>
              </Pressable>
            )
          }}
        />
      )}
    </BottomDrawer>
  )
}
