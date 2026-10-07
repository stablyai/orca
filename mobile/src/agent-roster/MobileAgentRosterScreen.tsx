import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronLeft, RefreshCw } from 'lucide-react-native'
import { setCachedWorktrees } from '../cache/worktree-cache'
import { useNow } from '../hooks/use-now'
import { firstParam } from '../navigation/route-param-reader'
import { colors, spacing } from '../theme/mobile-theme'
import { useHostClient } from '../transport/client-context'
import { loadHosts } from '../transport/host-store'
import { worktreeCatalogRead } from '../worktree/worktree-catalog-operations'
import { WORKTREE_PS_FULL_LIMIT } from '../worktree/worktree-catalog-snapshot-client'
import type { Worktree } from '../worktree/workspace-list-types'
import { AgentRosterRow } from './AgentRosterRow'
import { buildAgentRosterEntries, type AgentRosterEntry } from './agent-roster-entries'
import { styles } from './mobile-agent-roster-styles'

// A host-wide flat view of every agent; the workspace list only ever shows them nested inside a
// worktree row.
export function MobileAgentRosterScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ hostId?: string | string[] }>()
  // Through `firstParam`: expo-router returns an array for a repeated query key, and a bare read
  // would build a host id out of it (tasks.tsx:17-23).
  const hostId = firstParam(params.hostId)
  const { client, state: connState } = useHostClient(hostId)

  const [worktrees, setWorktrees] = useState<Worktree[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [hostName, setHostName] = useState('')
  const [clockEnabled, setClockEnabled] = useState(false)
  const [focusTick, setFocusTick] = useState(0)

  useFocusEffect(
    useCallback(() => {
      setClockEnabled(true)
      setFocusTick((tick) => tick + 1)
      return () => setClockEnabled(false)
    }, [])
  )
  const now = useNow(30_000, clockEnabled)

  useEffect(() => {
    if (!hostId) {
      return
    }
    let stale = false
    void loadHosts().then((hosts) => {
      if (!stale) {
        setHostName(hosts.find((host) => host.id === hostId)?.name ?? '')
      }
    })
    return () => {
      stale = true
    }
  }, [hostId])

  // Why: the route can hand this same instance a new hostId, so a slow reply for the old host must
  // not land on the new one (the host-name load below carries the same guard).
  const hostIdRef = useRef(hostId)
  hostIdRef.current = hostId

  const refresh = useCallback(async () => {
    if (!client || !hostId) {
      return
    }
    const requestHostId = hostId
    setRefreshing(true)
    try {
      const reply = await worktreeCatalogRead.requestSingleFlight(client, hostId, {
        limit: WORKTREE_PS_FULL_LIMIT
      })
      if (hostIdRef.current !== requestHostId) {
        return
      }
      const catalog = worktreeCatalogRead.interpret(reply)
      if (!catalog.accepted) {
        // Why (STA-3123): a refused read is not an empty host, so the last good rows stay put and
        // the failure shows as one line instead of dropping to a healthy-looking zero.
        setError('Could not load agents from host')
        return
      }
      // Why `?? []`: the member is salvaged, so a host answering without rows leaves it absent.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reader keeps these rows opaque because several screens project them differently; the roster touches only agents/worktreeId/displayName/repo/unread, each guarded inside buildAgentRosterEntries, and worktree-cache stores them as unknown[].
      const rows = (catalog.value.worktrees ?? []) as Worktree[]
      setWorktrees(rows)
      setCachedWorktrees(hostId, rows, { proven: true })
      setError(null)
    } catch (err) {
      if (hostIdRef.current === requestHostId) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setRefreshing(false)
    }
  }, [client, hostId])

  useEffect(() => {
    if (!client || connState !== 'connected') {
      return
    }
    void refresh()
  }, [client, connState, refresh, focusTick])

  const entries = useMemo(() => buildAgentRosterEntries(worktrees ?? []), [worktrees])

  const onOpenEntry = useCallback(
    (entry: AgentRosterEntry) => {
      // Session path mirrors the sidebar's open (host-workspace-list.tsx:186 →
      // use-host-worktree-actions.ts:226), plus the `paneKey` the session screen already consumes
      // to pick one pane (use-notification-pane-navigation.ts:16) — without it the tap lands on the
      // workspace's default tab and the agent still has to be found by hand.
      const paneKey = entry.agent.paneKey
        ? `&paneKey=${encodeURIComponent(entry.agent.paneKey)}`
        : ''
      router.push(
        `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(entry.worktreeId)}?name=${encodeURIComponent(entry.worktreeLabel)}${paneKey}`
      )
    },
    [hostId, router]
  )

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.topRow}>
        <Pressable
          style={styles.backButton}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <ChevronLeft size={22} color={colors.textPrimary} />
        </Pressable>
        <View style={styles.titleWrap}>
          <Text style={styles.heading}>Agents</Text>
          {hostName ? (
            <Text style={styles.subheading} numberOfLines={1}>
              {hostName}
            </Text>
          ) : null}
        </View>
        <Pressable
          style={styles.iconButton}
          onPress={() => void refresh()}
          disabled={!client || refreshing || connState !== 'connected'}
          accessibilityRole="button"
          accessibilityLabel="Refresh agents"
        >
          {refreshing ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <RefreshCw size={18} color={colors.textSecondary} />
          )}
        </Pressable>
      </View>

      {connState !== 'connected' && worktrees === null ? (
        <View style={styles.placeholder}>
          <ActivityIndicator color={colors.textSecondary} />
          <Text style={styles.placeholderText}>Connecting to {hostName || 'host'}…</Text>
        </View>
      ) : error && worktrees === null ? (
        <View style={styles.placeholder}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : worktrees === null ? (
        <View style={styles.placeholder}>
          <ActivityIndicator color={colors.textSecondary} />
          <Text style={styles.placeholderText}>Loading agents…</Text>
        </View>
      ) : (
        <>
          {error ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}
          <FlatList
            data={entries}
            keyExtractor={(entry) => entry.key}
            renderItem={({ item }) => (
              <AgentRosterRow entry={item} now={now} onPress={onOpenEntry} />
            )}
            ItemSeparatorComponent={ListSeparator}
            contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + spacing.xl }]}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => void refresh()}
                tintColor={colors.textSecondary}
                colors={[colors.textSecondary]}
              />
            }
            ListEmptyComponent={
              <View style={styles.placeholder}>
                <Text style={styles.placeholderText}>No agents on this host</Text>
              </View>
            }
          />
        </>
      )}
    </SafeAreaView>
  )
}

function ListSeparator() {
  return <View style={styles.separator} />
}
