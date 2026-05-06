import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  Pressable,
  ActivityIndicator,
  TextInput
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
  Search,
  X,
  Pin,
  Bell,
  GitPullRequest,
  SlidersHorizontal,
  Layers,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Plus,
  Moon,
  Filter,
  Check,
  UserCircle
} from 'lucide-react-native'
import type { RpcClient } from '../../../src/transport/rpc-client'
import { loadHosts, updateLastConnected, removeHost } from '../../../src/transport/host-store'
import {
  useHostClient,
  useCloseHost,
  useForceReconnect,
  useReconnectAttempt
} from '../../../src/transport/client-context'
import type { ConnectionState, RpcSuccess } from '../../../src/transport/types'
import { triggerMediumImpact } from '../../../src/platform/haptics'
import { StatusDot } from '../../../src/components/StatusDot'
import { NewWorktreeModal } from '../../../src/components/NewWorktreeModal'
import { AgentSpinner } from '../../../src/components/AgentSpinner'
import { PickerModal, type PickerOption } from '../../../src/components/PickerModal'
import { ActionSheetContent } from '../../../src/components/ActionSheetModal'
import { ConfirmModal } from '../../../src/components/ConfirmModal'
import { BottomDrawer } from '../../../src/components/BottomDrawer'
import { ProtocolBlockScreen } from '../../../src/components/ProtocolBlockScreen'
import { getCachedWorktrees } from '../../../src/cache/worktree-cache'
import { colors, radii, spacing, typography } from '../../../src/theme/mobile-theme'
import { evaluateCompat, type CompatVerdict } from '../../../src/transport/protocol-compat'
import {
  loadPinnedIds,
  savePinnedIds,
  loadPreferences,
  savePreferences
} from '../../../src/storage/preferences'

// Why: locally-typed subset of the desktop's RuntimeStatus we read from
// `status.get`. Only the version fields matter to mobile today; everything
// else is opaque. Both fields are optional since pre-PR desktops won't
// return them — the compat evaluator handles undefined gracefully.
type DesktopStatus = {
  protocolVersion?: number
  minCompatibleMobileVersion?: number
}

type Worktree = {
  worktreeId: string
  repo: string
  branch: string
  displayName: string
  // Why: on-disk worktree directory path. Needed by NewWorktreeModal so the
  // marine-creature fallback dedupes against the actual filesystem basenames
  // (matching the desktop's collision check), not against displayName which
  // the user may have renamed.
  path: string
  liveTerminalCount: number
  hasAttachedPty: boolean
  preview: string
  unread: boolean
  lastOutputAt?: number
  isPinned: boolean
  linkedPR: { number: number; state: string } | null
  status?: 'working' | 'active' | 'permission' | 'done' | 'inactive'
}

type SortMode = 'smart' | 'name' | 'recent'
type _FilterMode = 'all' | 'active'
type GroupMode = 'none' | 'repo' | 'prStatus'

type FilterState = {
  activeOnly: boolean
  selectedRepos: Set<string>
}

const STATUS_LABELS: Record<ConnectionState, string> = {
  connecting: 'Connecting…',
  handshaking: 'Securing…',
  connected: 'Connected',
  disconnected: 'Disconnected',
  reconnecting: 'Reconnecting…',
  'auth-failed': 'Auth failed'
}

// Why: same threshold as the home screen — kicks the label from
// "Reconnecting…" to "Can't connect" once the rpc-client has cycled enough
// times to indicate a real problem (wrong port, server down, network change).
const RECONNECT_FAILURE_THRESHOLD = 3

function getStatusDisplay(
  state: ConnectionState,
  attempts: number
): { label: string; isError: boolean } {
  if (state === 'auth-failed') return { label: 'Auth failed', isError: true }
  if (state === 'reconnecting' && attempts >= RECONNECT_FAILURE_THRESHOLD) {
    return { label: "Can't connect", isError: true }
  }
  return { label: STATUS_LABELS[state], isError: false }
}

const SORT_OPTIONS: PickerOption<SortMode>[] = [
  { value: 'smart', label: 'Smart', subtitle: 'Unread and active first' },
  { value: 'name', label: 'Name', subtitle: 'Alphabetical by name' },
  { value: 'recent', label: 'Recent', subtitle: 'Most recent output first' }
]

const GROUP_OPTIONS: PickerOption<GroupMode>[] = [
  { value: 'none', label: 'No Grouping' },
  { value: 'repo', label: 'Repository' },
  { value: 'prStatus', label: 'PR Status' }
]

function getWorktreeStatus(w: Worktree): 'working' | 'active' | 'permission' | 'done' | 'inactive' {
  if (w.status) return w.status
  if (w.liveTerminalCount > 0) return 'active'
  return 'inactive'
}

// Why: the previous 10-minute lastOutputAt window was too strict — most
// worktrees with idle terminal prompts had no recent output and were excluded.
// Any worktree with live terminals or unread output counts as "active".
function isWorktreeActive(w: Worktree): boolean {
  if (w.unread) return true
  if (w.status) return w.status !== 'inactive'
  if (w.liveTerminalCount > 0) return true
  return false
}

function sortWorktrees(worktrees: Worktree[], mode: SortMode): Worktree[] {
  return [...worktrees].sort((a, b) => {
    if (mode === 'name') return (a.displayName || a.repo).localeCompare(b.displayName || b.repo)
    if (mode === 'recent') return (b.lastOutputAt ?? 0) - (a.lastOutputAt ?? 0)
    // 'smart' — attention-first
    if (a.unread !== b.unread) return a.unread ? -1 : 1
    const aStatus = getWorktreeStatus(a)
    const bStatus = getWorktreeStatus(b)
    const statusOrder = { permission: 0, working: 1, done: 2, active: 3, inactive: 4 }
    if (statusOrder[aStatus] !== statusOrder[bStatus])
      return statusOrder[aStatus] - statusOrder[bStatus]
    if ((a.lastOutputAt ?? 0) !== (b.lastOutputAt ?? 0))
      return (b.lastOutputAt ?? 0) - (a.lastOutputAt ?? 0)
    return (a.displayName || a.repo).localeCompare(b.displayName || b.repo)
  })
}

function filterWorktrees(worktrees: Worktree[], filters: FilterState, search: string): Worktree[] {
  let result = worktrees
  if (filters.activeOnly) {
    result = result.filter(isWorktreeActive)
  }
  if (filters.selectedRepos.size > 0) {
    result = result.filter((w) => filters.selectedRepos.has(w.repo))
  }
  if (search.trim()) {
    const q = search.toLowerCase()
    result = result.filter(
      (w) =>
        (w.displayName || w.repo).toLowerCase().includes(q) ||
        w.branch.toLowerCase().includes(q) ||
        w.repo.toLowerCase().includes(q)
    )
  }
  return result
}

type Section = { title: string; icon?: 'pin'; data: Worktree[] }

// Why: matches desktop's PR_GROUP_META naming from worktree-list-groups.ts.
// no PR/draft/unknown → "In Progress", open → "In Review", merged → "Done", closed → "Closed"
type PRGroupKey = 'done' | 'in-review' | 'in-progress' | 'closed'

const PR_GROUP_LABELS: Record<PRGroupKey, string> = {
  done: 'Done',
  'in-review': 'In Review',
  'in-progress': 'In Progress',
  closed: 'Closed'
}

const PR_GROUP_ORDER: PRGroupKey[] = ['done', 'in-review', 'in-progress', 'closed']

function getPRGroupKey(w: Worktree): PRGroupKey {
  if (!w.linkedPR) return 'in-progress'
  const s = w.linkedPR.state.toLowerCase()
  if (s === 'merged') return 'done'
  if (s === 'closed') return 'closed'
  if (s === 'draft') return 'in-progress'
  return 'in-review'
}

function isWorktreePinned(w: Worktree, localPins: Set<string>): boolean {
  return w.isPinned || localPins.has(w.worktreeId)
}

function buildSections(
  worktrees: Worktree[],
  sortMode: SortMode,
  filters: FilterState,
  search: string,
  groupMode: GroupMode,
  pinnedIds: Set<string>
): Section[] {
  const filtered = filterWorktrees(worktrees, filters, search)
  const sorted = sortWorktrees(filtered, sortMode)

  const pinned = sorted.filter((w) => isWorktreePinned(w, pinnedIds))
  const unpinned = sorted.filter((w) => !isWorktreePinned(w, pinnedIds))
  const active = unpinned.filter(isWorktreeActive)
  const inactive = unpinned.filter((w) => !isWorktreeActive(w))

  const sections: Section[] = []
  if (pinned.length > 0) {
    sections.push({ title: 'Pinned', icon: 'pin', data: pinned })
  }

  if (groupMode === 'none') {
    if (active.length > 0) {
      // Why: without explicit grouping, mobile's primary workflow is jumping
      // back into running sessions before browsing the full worktree archive.
      sections.push({ title: 'Active', data: active })
    }
    if (inactive.length > 0) {
      sections.push({ title: pinned.length > 0 || active.length > 0 ? 'All' : '', data: inactive })
    }
  } else if (groupMode === 'repo') {
    const byRepo = new Map<string, Worktree[]>()
    for (const w of unpinned) {
      const key = w.repo || 'Unknown'
      const list = byRepo.get(key)
      if (list) list.push(w)
      else byRepo.set(key, [w])
    }
    for (const [repo, items] of byRepo) {
      sections.push({ title: repo, data: items })
    }
  } else if (groupMode === 'prStatus') {
    const byGroup = new Map<PRGroupKey, Worktree[]>()
    for (const w of unpinned) {
      const key = getPRGroupKey(w)
      const list = byGroup.get(key)
      if (list) list.push(w)
      else byGroup.set(key, [w])
    }
    for (const groupKey of PR_GROUP_ORDER) {
      const items = byGroup.get(groupKey)
      if (items && items.length > 0) {
        sections.push({ title: PR_GROUP_LABELS[groupKey], data: items })
      }
    }
  }

  return sections
}

export default function HostScreen() {
  const { hostId, action } = useLocalSearchParams<{ hostId: string; action?: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [initialCache] = useState(() =>
    hostId ? (getCachedWorktrees(hostId) as Worktree[] | null) : null
  )
  // Why: shared client per host owned by RpcClientProvider. See
  // docs/mobile-shared-client-per-host.md.
  const { client, state: connState } = useHostClient(hostId)
  const reconnectAttempts = useReconnectAttempt(hostId)
  const clientRef = useRef<RpcClient | null>(null)
  const closeHostClient = useCloseHost()
  const forceReconnectHost = useForceReconnect()
  const [worktrees, setWorktrees] = useState<Worktree[]>(initialCache ?? [])
  const [worktreesLoaded, setWorktreesLoaded] = useState(initialCache != null)
  const [hostName, setHostName] = useState('')
  const [error, setError] = useState('')
  const [compatVerdict, setCompatVerdict] = useState<CompatVerdict>({ kind: 'ok' })
  const [lastKnownWorktrees, setLastKnownWorktrees] = useState<Worktree[]>(initialCache ?? [])
  const [search, setSearch] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [sortMode, setSortMode] = useState<SortMode>('smart')
  const [filters, setFilters] = useState<FilterState>({
    activeOnly: false,
    selectedRepos: new Set()
  })
  const [groupMode, setGroupMode] = useState<GroupMode>('none')

  // Modals
  const [showSortPicker, setShowSortPicker] = useState(false)
  const [showGroupPicker, setShowGroupPicker] = useState(false)
  const [showFilterModal, setShowFilterModal] = useState(false)
  const [actionTarget, setActionTarget] = useState<Worktree | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Worktree | null>(null)
  const [confirmRemoveHost, setConfirmRemoveHost] = useState(false)
  const [showNewWorktree, setShowNewWorktree] = useState(false)
  const [sleptIds, setSleptIds] = useState<Set<string>>(new Set())

  // Persisted pin state
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set())
  const [_prefsLoaded, setPrefsLoaded] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (action === 'newWorktree') setShowNewWorktree(true)
  }, [action])

  // Load persisted pins and preferences
  useEffect(() => {
    if (!hostId) return
    let stale = false
    void (async () => {
      const [pins, prefs] = await Promise.all([loadPinnedIds(hostId), loadPreferences(hostId)])
      if (stale) return
      setPinnedIds(pins)
      setSortMode(prefs.sortMode as SortMode)
      setFilters({
        activeOnly: prefs.filterMode === 'active',
        selectedRepos: new Set(prefs.selectedRepos ?? [])
      })
      setGroupMode(prefs.groupMode as GroupMode)
      setCollapsedGroups(new Set(prefs.collapsedGroups))
      setPrefsLoaded(true)
    })()
    return () => {
      stale = true
    }
  }, [hostId])

  // Why: keep clientRef in sync so existing imperative call sites work
  // unchanged. Also re-seed the cached worktree list on hostId change
  // since the useState initializer only runs on first mount.
  useEffect(() => {
    clientRef.current = client
  }, [client])

  useEffect(() => {
    setHostName('')
    setError('')
    setCompatVerdict({ kind: 'ok' })
    // Why: re-seed from the current host's cache on every hostId change.
    // The useState initializer only runs on first mount, so if Expo Router
    // reuses this screen with a different hostId, we must reset here.
    const freshCache = hostId ? (getCachedWorktrees(hostId) as Worktree[] | null) : null
    if (freshCache) {
      setWorktrees(freshCache)
      setLastKnownWorktrees(freshCache)
      setWorktreesLoaded(true)
    } else {
      setWorktreesLoaded(false)
      setWorktrees([])
      setLastKnownWorktrees([])
    }
    if (!hostId) return
    let stale = false
    void loadHosts().then((hosts) => {
      if (stale) return
      const host = hosts.find((h) => h.id === hostId)
      if (!host) {
        setError('Host not found')
        return
      }
      setHostName(host.name)
      void updateLastConnected(host.id)
    })
    return () => {
      stale = true
    }
  }, [hostId])

  const fetchWorktrees = useCallback(async () => {
    if (!client || connState !== 'connected') return
    const requestClient = client
    const requestHostId = hostId

    try {
      const response = await requestClient.sendRequest('worktree.ps')
      if (clientRef.current !== requestClient || hostId !== requestHostId) return
      if (response.ok) {
        const result = (response as RpcSuccess).result as { worktrees: Worktree[] }
        setWorktrees(result.worktrees)
        setLastKnownWorktrees(result.worktrees)
        setWorktreesLoaded(true)

        // Clear optimistic sleep overrides once the server confirms the
        // worktree is actually inactive (liveTerminalCount dropped to 0).
        setSleptIds((prev) => {
          if (prev.size === 0) {
            return prev
          }
          const still = new Set<string>()
          for (const id of prev) {
            const wt = result.worktrees.find((w) => w.worktreeId === id)
            if (wt && wt.liveTerminalCount > 0) {
              still.add(id)
            }
          }
          return still.size === prev.size ? prev : still
        })

        // Sync local pin state from server so desktop-initiated pins/unpins
        // are reflected without relying on stale AsyncStorage.
        const serverPinned = new Set(
          result.worktrees.filter((w) => w.isPinned).map((w) => w.worktreeId)
        )
        setPinnedIds((prev) => {
          if (serverPinned.size === prev.size && [...serverPinned].every((id) => prev.has(id))) {
            return prev
          }
          if (hostId) void savePinnedIds(hostId, serverPinned)
          return serverPinned
        })
      }
    } catch {
      // Will retry on reconnect
    }
  }, [client, connState, hostId])

  useEffect(() => {
    if (connState === 'connected') {
      void fetchWorktrees()
    }
  }, [connState, fetchWorktrees])

  // Why: read desktop's protocol version from status.get on every connect
  // and re-evaluate compatibility. If the desktop declares this mobile
  // build too old (or vice versa via the local minimum), the host detail
  // screen swaps to a hard-block screen instead of the worktree list.
  // Today's compat constants are wide-open so this never blocks; the wire
  // format is in place to flip a switch in a future release.
  useEffect(() => {
    if (connState !== 'connected' || !client) return
    let cancelled = false
    const requestClient = client
    void (async () => {
      try {
        const response = await requestClient.sendRequest('status.get')
        if (cancelled || clientRef.current !== requestClient) return
        if (!response.ok) return
        const status = (response as RpcSuccess).result as DesktopStatus
        const verdict = evaluateCompat({
          desktopProtocolVersion: status.protocolVersion,
          desktopMinCompatibleMobileVersion: status.minCompatibleMobileVersion
        })
        setCompatVerdict(verdict)
        if (verdict.kind === 'blocked') {
          // Why: deterministic breadcrumb so support can confirm a block
          // actually fired (vs a render bug). No PII — just version ints.
          console.warn('[protocol-compat] blocked', {
            reason: verdict.reason,
            desktopVersion: verdict.desktopVersion,
            requiredMobileVersion: verdict.requiredMobileVersion,
            requiredDesktopVersion: verdict.requiredDesktopVersion
          })
        }
      } catch {
        // Why: rare path — sendRequest can throw on transport tear-down.
        // Treat as transient; verdict stays at previous value.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [connState, client])

  useEffect(() => {
    if (connState !== 'connected') return
    const interval = setInterval(() => {
      void fetchWorktrees()
    }, 3000)
    return () => clearInterval(interval)
  }, [connState, fetchWorktrees])

  const updateLocalPins = useCallback(
    (worktreeId: string, pinned: boolean) => {
      setPinnedIds((prev) => {
        const next = new Set(prev)
        if (pinned) next.add(worktreeId)
        else next.delete(worktreeId)
        if (hostId) void savePinnedIds(hostId, next)
        return next
      })
    },
    [hostId]
  )

  const togglePin = useCallback(
    (worktreeId: string) => {
      const worktree = worktrees.find((w) => w.worktreeId === worktreeId)
      const currentlyPinned = worktree
        ? isWorktreePinned(worktree, pinnedIds)
        : pinnedIds.has(worktreeId)
      const newPinned = !currentlyPinned

      setWorktrees((prev) =>
        prev.map((w) => (w.worktreeId === worktreeId ? { ...w, isPinned: newPinned } : w))
      )
      setLastKnownWorktrees((prev) =>
        prev.map((w) => (w.worktreeId === worktreeId ? { ...w, isPinned: newPinned } : w))
      )

      updateLocalPins(worktreeId, newPinned)

      if (client) {
        client
          .sendRequest('worktree.set', {
            worktree: `id:${worktreeId}`,
            isPinned: newPinned
          })
          .catch(() => {})
      }
    },
    [client, worktrees, pinnedIds, updateLocalPins]
  )

  const handleDeleteWorktree = useCallback(
    async (item: Worktree) => {
      if (!client) return

      const removeFromList = (list: Worktree[]) =>
        list.filter((w) => w.worktreeId !== item.worktreeId)
      setWorktrees(removeFromList)
      setLastKnownWorktrees(removeFromList)

      try {
        const response = await client.sendRequest('worktree.rm', {
          worktree: `id:${item.worktreeId}`,
          force: true
        })
        if (!response.ok) {
          setWorktrees((prev) => [...prev, item])
          setLastKnownWorktrees((prev) => [...prev, item])
        }
        void fetchWorktrees()
      } catch {
        setWorktrees((prev) => [...prev, item])
        setLastKnownWorktrees((prev) => [...prev, item])
      }
    },
    [client, fetchWorktrees]
  )

  const handleRemoveHost = useCallback(async () => {
    if (!hostId) return
    // Why: close the shared client first so its WebSocket is gone before
    // the host record disappears; otherwise the next loadHosts() the
    // provider does (e.g. on remount) wouldn't find this host but the
    // socket would still be open, leaking state.
    closeHostClient(hostId)
    await removeHost(hostId)
    router.back()
  }, [hostId, router, closeHostClient])

  const openWorktreeSession = useCallback(
    (item: Worktree) => {
      if (client && connState === 'connected') {
        void client
          .sendRequest('worktree.activate', {
            worktree: `id:${item.worktreeId}`
          })
          .catch(() => null)
      }
      router.push(
        `/h/${hostId}/session/${encodeURIComponent(item.worktreeId)}?name=${encodeURIComponent(item.displayName || item.repo)}`
      )
    },
    [client, connState, hostId, router]
  )

  const handleSortChange = useCallback(
    (value: SortMode) => {
      setSortMode(value)
      if (hostId) void savePreferences(hostId, { sortMode: value })
    },
    [hostId]
  )

  const toggleActiveFilter = useCallback(() => {
    setFilters((prev) => {
      const next = { ...prev, activeOnly: !prev.activeOnly }
      if (hostId)
        void savePreferences(hostId, {
          filterMode: next.activeOnly ? 'active' : 'all'
        })
      return next
    })
  }, [hostId])

  const toggleRepoFilter = useCallback(
    (repo: string) => {
      setFilters((prev) => {
        const next = new Set(prev.selectedRepos)
        if (next.has(repo)) next.delete(repo)
        else next.add(repo)
        const updated = { ...prev, selectedRepos: next }
        if (hostId) void savePreferences(hostId, { selectedRepos: [...next] })
        return updated
      })
    },
    [hostId]
  )

  const clearFilters = useCallback(() => {
    setFilters({ activeOnly: false, selectedRepos: new Set() })
    if (hostId) void savePreferences(hostId, { filterMode: 'all', selectedRepos: [] })
  }, [hostId])

  const activeFilterCount = useMemo(() => {
    let count = 0
    if (filters.activeOnly) count++
    count += filters.selectedRepos.size
    return count
  }, [filters])

  const handleGroupChange = useCallback(
    (value: GroupMode) => {
      setGroupMode(value)
      if (hostId) void savePreferences(hostId, { groupMode: value })
    },
    [hostId]
  )

  const displayWorktrees = useMemo(() => {
    const base =
      connState === 'disconnected' || connState === 'reconnecting' || connState === 'auth-failed'
        ? lastKnownWorktrees
        : worktrees
    if (sleptIds.size === 0) {
      return base
    }
    return base.map((w) =>
      sleptIds.has(w.worktreeId)
        ? { ...w, liveTerminalCount: 0, hasAttachedPty: false, status: 'inactive' as const }
        : w
    )
  }, [connState, worktrees, lastKnownWorktrees, sleptIds])

  const uniqueRepos = useMemo(() => {
    const repos = new Map<string, string>()
    for (const w of displayWorktrees) {
      if (!repos.has(w.repo)) repos.set(w.repo, repoColor(w.repo))
    }
    return [...repos.entries()].map(([name, color]) => ({ name, color }))
  }, [displayWorktrees])

  const toggleCollapsed = useCallback(
    (title: string) => {
      setCollapsedGroups((prev) => {
        const next = new Set(prev)
        if (next.has(title)) next.delete(title)
        else next.add(title)
        if (hostId) void savePreferences(hostId, { collapsedGroups: [...next] })
        return next
      })
    },
    [hostId]
  )

  const rawSections = useMemo(
    () => buildSections(displayWorktrees, sortMode, filters, search, groupMode, pinnedIds),
    [displayWorktrees, sortMode, filters, search, groupMode, pinnedIds]
  )

  const sections = useMemo(
    () =>
      rawSections.map((s) => ({
        ...s,
        data: collapsedGroups.has(s.title) ? [] : s.data
      })),
    [rawSections, collapsedGroups]
  )

  const isReadOnly = connState === 'auth-failed'

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    )
  }

  if (compatVerdict.kind === 'blocked') {
    return <ProtocolBlockScreen verdict={compatVerdict} />
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.topChrome}>
        <View style={styles.statusBar}>
          <Pressable style={styles.backButton} onPress={() => router.back()}>
            <ChevronLeft size={22} color={colors.textPrimary} />
          </Pressable>
          <View style={styles.hostIdentity}>
            <StatusDot state={connState} />
            <Text style={styles.hostNameText} numberOfLines={1}>
              {hostName || 'Host'}
            </Text>
          </View>
          {connState !== 'connected' &&
            (() => {
              const status = getStatusDisplay(connState, reconnectAttempts)
              const showReconnectButton = status.isError && hostId && connState !== 'auth-failed'
              return (
                <View style={styles.statusRow}>
                  <Text style={[styles.statusText, status.isError && { color: colors.statusRed }]}>
                    {status.label}
                  </Text>
                  {showReconnectButton && (
                    <Pressable
                      style={styles.reconnectButton}
                      onPress={() => void forceReconnectHost(hostId!)}
                      hitSlop={8}
                    >
                      <Text style={styles.reconnectButtonText}>Reconnect</Text>
                    </Pressable>
                  )}
                </View>
              )
            })()}
        </View>

        {/* Filter/sort/group toolbar */}
        <View style={styles.toolbar}>
          <Pressable
            style={[styles.filterChip, activeFilterCount > 0 && styles.filterChipActive]}
            onPress={() => setShowFilterModal(true)}
          >
            <Filter
              size={12}
              color={activeFilterCount > 0 ? colors.textPrimary : colors.textSecondary}
            />
            <Text
              style={[styles.filterChipText, activeFilterCount > 0 && styles.filterChipTextActive]}
            >
              Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
            </Text>
          </Pressable>

          <Pressable style={styles.sortButton} onPress={() => setShowSortPicker(true)}>
            <SlidersHorizontal size={14} color={colors.textSecondary} />
            <Text style={styles.sortLabel}>
              {sortMode === 'smart' ? 'Smart' : sortMode === 'name' ? 'Name' : 'Recent'}
            </Text>
          </Pressable>

          <Pressable style={styles.groupButton} onPress={() => setShowGroupPicker(true)}>
            <Layers size={14} color={colors.textSecondary} />
            <Text style={styles.sortLabel}>
              {groupMode === 'none' ? 'Group' : groupMode === 'repo' ? 'Repo' : 'PR'}
            </Text>
          </Pressable>

          <View style={styles.toolbarSpacer} />

          <Pressable
            style={styles.searchToggle}
            onPress={() => router.push(`/h/${hostId}/accounts`)}
            disabled={connState !== 'connected'}
          >
            <UserCircle
              size={16}
              color={connState === 'connected' ? colors.textSecondary : colors.textMuted}
            />
          </Pressable>

          <Pressable
            style={styles.newButton}
            onPress={() => setShowNewWorktree(true)}
            disabled={connState !== 'connected'}
          >
            <Plus
              size={16}
              color={connState === 'connected' ? colors.textPrimary : colors.textMuted}
            />
          </Pressable>

          <Pressable style={styles.searchToggle} onPress={() => setShowSearch((s) => !s)}>
            {showSearch ? (
              <X size={16} color={colors.textSecondary} />
            ) : (
              <Search size={16} color={colors.textSecondary} />
            )}
          </Pressable>
        </View>
      </View>

      {/* Auth failed banner */}
      {connState === 'auth-failed' && (
        <View style={styles.authBanner}>
          <Text style={styles.authBannerText}>
            Pairing rejected — re-pair from desktop or remove this host.
          </Text>
          <View style={styles.authActions}>
            <Pressable style={styles.authAction} onPress={() => router.push('/pair-scan')}>
              <Text style={styles.authActionText}>Re-pair</Text>
            </Pressable>
            <Pressable style={styles.authAction} onPress={() => setConfirmRemoveHost(true)}>
              <Text style={[styles.authActionText, { color: colors.statusRed }]}>Remove</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Search bar */}
      {showSearch && (
        <View style={styles.searchBar}>
          <Search size={14} color={colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
            placeholder="Search worktrees…"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
          />
          {search.length > 0 && (
            <Pressable onPress={() => setSearch('')}>
              <X size={14} color={colors.textSecondary} />
            </Pressable>
          )}
        </View>
      )}

      {/* Loading state */}
      {((connState === 'connecting' || connState === 'reconnecting') &&
        displayWorktrees.length === 0) ||
      (connState === 'connected' && !worktreesLoaded && displayWorktrees.length === 0) ? (
        <View style={styles.centered}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
        </View>
      ) : null}

      {/* Empty state */}
      {connState === 'connected' && worktreesLoaded && sections.length === 0 && (
        <View style={styles.centered}>
          <Text style={styles.emptyText}>
            {search
              ? 'No matching worktrees'
              : activeFilterCount > 0
                ? 'No worktrees match filters'
                : 'No worktrees'}
          </Text>
        </View>
      )}

      {/* Worktree list */}
      {sections.length > 0 && (
        <SectionList
          sections={sections}
          keyExtractor={(w) => w.worktreeId}
          stickySectionHeadersEnabled={false}
          // Why: edge-to-edge — the list scrolls under the system nav bar
          // while reserving insets.bottom keeps the last worktree row reachable
          // above the Samsung 3-button nav / iOS home indicator.
          contentContainerStyle={[styles.list, { paddingBottom: spacing.lg + insets.bottom }]}
          renderSectionHeader={({ section }) => {
            if (!section.title) return null
            const isCollapsed = collapsedGroups.has(section.title)
            const rawSection = rawSections.find((s) => s.title === section.title)
            const count = rawSection?.data.length ?? 0
            return (
              <Pressable
                style={styles.sectionHeader}
                onPress={() => toggleCollapsed(section.title)}
              >
                {isCollapsed ? (
                  <ChevronRight size={12} color={colors.textMuted} style={styles.sectionIcon} />
                ) : (
                  <ChevronDown size={12} color={colors.textMuted} style={styles.sectionIcon} />
                )}
                {section.icon === 'pin' && (
                  <Pin size={12} color={colors.textMuted} style={styles.sectionIcon} />
                )}
                <Text style={styles.sectionTitle}>{section.title}</Text>
                <Text style={styles.sectionCount}>{count}</Text>
              </Pressable>
            )
          }}
          ItemSeparatorComponent={ListSeparator}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.worktreeRow, pressed && styles.worktreeRowPressed]}
              disabled={isReadOnly}
              onPress={() => openWorktreeSession(item)}
              onLongPress={() => {
                triggerMediumImpact()
                setActionTarget(item)
              }}
              delayLongPress={400}
            >
              {/* Left indicator */}
              <View style={styles.indicatorCol}>
                <AgentSpinner status={getWorktreeStatus(item)} />
                {item.unread && (
                  <Bell
                    size={10}
                    color={colors.statusAmber}
                    fill={colors.statusAmber}
                    style={styles.unreadBell}
                  />
                )}
              </View>

              {/* Main content */}
              <View style={styles.worktreeMain}>
                <View style={styles.worktreeNameRow}>
                  <Text
                    style={[styles.worktreeName, isReadOnly && styles.textReadOnly]}
                    numberOfLines={1}
                  >
                    {item.displayName || item.repo}
                  </Text>
                  {item.linkedPR && (
                    <View style={styles.prBadge}>
                      <GitPullRequest size={10} color={colors.textSecondary} />
                      <Text style={styles.prNumber}>#{item.linkedPR.number}</Text>
                    </View>
                  )}
                </View>
                <View style={styles.worktreeMetaRow}>
                  <View style={[styles.repoDot, { backgroundColor: repoColor(item.repo) }]} />
                  <Text style={styles.repoName} numberOfLines={1}>
                    {item.repo}
                  </Text>
                  <Text style={styles.branchName} numberOfLines={1}>
                    {item.branch}
                  </Text>
                </View>
                {item.preview ? (
                  <Text style={styles.worktreePreview} numberOfLines={1}>
                    {item.preview}
                  </Text>
                ) : null}
              </View>

              {/* Terminal count */}
              {item.liveTerminalCount > 0 && (
                <Text style={styles.terminalCount}>{item.liveTerminalCount}</Text>
              )}
            </Pressable>
          )}
        />
      )}

      {/* Sort picker modal */}
      <PickerModal
        visible={showSortPicker}
        title="Sort By"
        options={SORT_OPTIONS}
        selected={sortMode}
        onSelect={handleSortChange}
        onClose={() => setShowSortPicker(false)}
      />

      {/* Group picker modal */}
      <PickerModal
        visible={showGroupPicker}
        title="Group By"
        options={GROUP_OPTIONS}
        selected={groupMode}
        onSelect={handleGroupChange}
        onClose={() => setShowGroupPicker(false)}
      />

      {/* Filter modal — matches desktop's Status + Repositories dropdown */}
      <BottomDrawer visible={showFilterModal} onClose={() => setShowFilterModal(false)}>
        <View style={styles.filterModalHeader}>
          <Text style={styles.filterModalTitle}>Filter</Text>
          {activeFilterCount > 0 && (
            <Pressable onPress={clearFilters}>
              <Text style={styles.clearFiltersText}>Clear filters</Text>
            </Pressable>
          )}
        </View>

        <Text style={styles.filterSectionLabel}>Status</Text>
        <View style={styles.filterGroup}>
          <Pressable style={styles.filterRow} onPress={toggleActiveFilter}>
            <Text style={styles.filterRowText}>Active only</Text>
            {filters.activeOnly && <Check size={14} color={colors.textPrimary} />}
          </Pressable>
        </View>

        {uniqueRepos.length > 1 && (
          <>
            <Text style={styles.filterSectionLabel}>Repositories</Text>
            <View style={styles.filterGroup}>
              {uniqueRepos.map((repo, i) => (
                <View key={repo.name}>
                  {i > 0 && <View style={styles.filterSeparator} />}
                  <Pressable style={styles.filterRow} onPress={() => toggleRepoFilter(repo.name)}>
                    <View style={[styles.filterRepoDot, { backgroundColor: repo.color }]} />
                    <Text style={styles.filterRowText} numberOfLines={1}>
                      {repo.name}
                    </Text>
                    {filters.selectedRepos.has(repo.name) && (
                      <Check size={14} color={colors.textPrimary} />
                    )}
                  </Pressable>
                </View>
              ))}
            </View>
          </>
        )}
      </BottomDrawer>

      {/* Worktree long-press action sheet (inline confirm to avoid double-Modal lag) */}
      <BottomDrawer
        visible={actionTarget != null}
        onClose={() => {
          setConfirmDelete(null)
          setActionTarget(null)
        }}
      >
        {confirmDelete ? (
          <View>
            <View style={styles.confirmContent}>
              <Text style={styles.confirmTitle}>Delete Worktree</Text>
              <Text style={styles.confirmMessage}>
                Delete "{confirmDelete.displayName || confirmDelete.repo}" ({confirmDelete.branch})?
              </Text>
            </View>
            <View style={styles.confirmButtons}>
              <Pressable
                style={({ pressed }) => [
                  styles.confirmBtn,
                  styles.confirmBtnCancel,
                  pressed && styles.confirmBtnPressed
                ]}
                onPress={() => setConfirmDelete(null)}
              >
                <Text style={styles.confirmBtnCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.confirmBtn,
                  styles.confirmBtnDestructive,
                  pressed && styles.confirmBtnPressed
                ]}
                onPress={() => {
                  if (confirmDelete) {
                    void handleDeleteWorktree(confirmDelete)
                  }
                  setConfirmDelete(null)
                  setActionTarget(null)
                }}
              >
                <Text style={styles.confirmBtnDestructiveText}>Delete</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <ActionSheetContent
            title={actionTarget ? actionTarget.displayName || actionTarget.repo : undefined}
            message={actionTarget?.branch}
            actions={
              actionTarget
                ? [
                    {
                      label: 'Sleep',
                      icon: Moon,
                      onPress: () => {
                        if (client) {
                          setSleptIds((prev) => new Set(prev).add(actionTarget.worktreeId))
                          void client
                            .sendRequest('worktree.sleep', {
                              worktree: `id:${actionTarget.worktreeId}`
                            })
                            .catch(() => null)
                        }
                        setActionTarget(null)
                      }
                    },
                    {
                      label: isWorktreePinned(actionTarget, pinnedIds) ? 'Unpin' : 'Pin',
                      onPress: () => {
                        togglePin(actionTarget.worktreeId)
                        setActionTarget(null)
                      }
                    },
                    {
                      label: 'Delete',
                      destructive: true,
                      onPress: () => setConfirmDelete(actionTarget)
                    }
                  ]
                : []
            }
          />
        )}
      </BottomDrawer>

      {/* Host remove confirmation */}
      <ConfirmModal
        visible={confirmRemoveHost}
        title="Remove Host"
        message={`Remove "${hostName}"? You can re-pair later.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => void handleRemoveHost()}
        onCancel={() => setConfirmRemoveHost(false)}
      />

      <NewWorktreeModal
        visible={showNewWorktree}
        client={client}
        existingWorktreePaths={worktrees.map((w) => w.path)}
        onCreated={(worktreeId, worktreeName) => {
          void fetchWorktrees()
          const params = new URLSearchParams({ name: worktreeName, created: '1' })
          router.push(`/h/${hostId}/session/${encodeURIComponent(worktreeId)}?${params.toString()}`)
        }}
        onClose={() => setShowNewWorktree(false)}
      />
    </SafeAreaView>
  )
}

function ListSeparator() {
  return <View style={styles.separator} />
}

function repoColor(name: string): string {
  const palette = ['#f97316', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f59e0b', '#6366f1']
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return palette[Math.abs(hash) % palette.length]!
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  topChrome: {
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 34,
    paddingTop: spacing.xs,
    paddingHorizontal: spacing.lg
  },
  backButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.xs
  },
  hostIdentity: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    marginRight: spacing.md
  },
  hostNameText: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary
  },
  statusText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  reconnectButton: {
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  reconnectButtonText: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  authBanner: {
    backgroundColor: colors.bgPanel,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  authBannerText: {
    color: colors.statusRed,
    fontSize: 13,
    marginBottom: spacing.sm
  },
  authActions: {
    flexDirection: 'row',
    gap: spacing.lg
  },
  authAction: {
    paddingVertical: spacing.xs
  },
  authActionText: {
    color: colors.accentBlue,
    fontSize: 13,
    fontWeight: '600'
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  filterChipActive: {
    borderColor: colors.textSecondary,
    backgroundColor: colors.bgRaised
  },
  filterChipText: {
    fontSize: 12,
    color: colors.textSecondary
  },
  filterChipTextActive: {
    color: colors.textPrimary
  },
  sortButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  groupButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  sortLabel: {
    fontSize: 12,
    color: colors.textSecondary
  },
  toolbarSpacer: {
    flex: 1
  },
  newButton: {
    padding: spacing.xs
  },
  searchToggle: {
    padding: spacing.xs
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  searchInput: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 13,
    paddingVertical: 2
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize
  },
  errorText: {
    color: colors.statusRed,
    fontSize: typography.bodySize
  },
  list: {
    paddingBottom: spacing.lg
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs
  },
  sectionIcon: {
    marginRight: spacing.xs
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  sectionCount: {
    fontSize: 11,
    color: colors.textMuted,
    marginLeft: spacing.xs
  },
  separator: {
    height: 1,
    backgroundColor: colors.borderSubtle,
    marginLeft: spacing.lg + 24,
    marginRight: spacing.lg
  },
  worktreeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg
  },
  worktreeRowPressed: {
    backgroundColor: colors.bgRaised
  },
  indicatorCol: {
    width: 20,
    alignItems: 'center',
    paddingTop: 6,
    marginRight: spacing.sm,
    gap: 4
  },
  unreadBell: {
    marginTop: 2
  },
  worktreeMain: {
    flex: 1,
    marginRight: spacing.sm
  },
  worktreeNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  worktreeName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    flexShrink: 1
  },
  textReadOnly: {
    opacity: 0.5
  },
  prBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4
  },
  prNumber: {
    fontSize: 10,
    color: colors.textSecondary
  },
  worktreeMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
    gap: spacing.xs
  },
  repoDot: {
    width: 6,
    height: 6,
    borderRadius: 3
  },
  repoName: {
    fontSize: 11,
    color: colors.textSecondary,
    maxWidth: 100
  },
  branchName: {
    fontSize: 11,
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    flexShrink: 1
  },
  worktreePreview: {
    fontSize: 11,
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    marginTop: 2
  },
  terminalCount: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    minWidth: 16,
    textAlign: 'right',
    paddingTop: 3
  },
  filterModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.md
  },
  filterModalTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary
  },
  clearFiltersText: {
    fontSize: 13,
    color: colors.textSecondary
  },
  filterSectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.xs
  },
  filterGroup: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: spacing.md
  },
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2,
    gap: spacing.sm
  },
  filterRowText: {
    flex: 1,
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  filterSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  filterRepoDot: {
    width: 8,
    height: 8,
    borderRadius: 4
  },
  confirmContent: {
    paddingBottom: spacing.lg
  },
  confirmTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary
  },
  confirmMessage: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    lineHeight: 20
  },
  confirmButtons: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  confirmBtn: {
    flex: 1,
    paddingVertical: spacing.sm + 2,
    borderRadius: 10,
    alignItems: 'center'
  },
  confirmBtnCancel: {
    backgroundColor: colors.bgPanel
  },
  confirmBtnDestructive: {
    backgroundColor: colors.statusRed
  },
  confirmBtnPressed: {
    opacity: 0.7
  },
  confirmBtnCancelText: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textSecondary
  },
  confirmBtnDestructiveText: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: '#fff'
  }
})
