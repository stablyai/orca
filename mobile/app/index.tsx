import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { View, Text, StyleSheet, Pressable, FlatList } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter, useFocusEffect } from 'expo-router'
import {
  Monitor,
  QrCode,
  Settings,
  Bot,
  Clock,
  GitPullRequest,
  ChevronRight,
  Terminal,
  Plus,
  RefreshCw,
  PowerOff,
  Edit3
} from 'lucide-react-native'
import { ClaudeIcon, OpenAIIcon } from '../src/components/AgentIcons'
import {
  type AccountsSnapshot,
  type ProviderKey,
  getActiveProviderRateLimits,
  UsageBar
} from '../src/components/AccountUsage'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { loadHosts, removeHost, renameHost } from '../src/transport/host-store'
import type { RpcClient } from '../src/transport/rpc-client'
import {
  useAllHostClients,
  useCloseHost,
  useForceReconnect,
  usePrimeHosts
} from '../src/transport/client-context'
import { classifyConnection } from '../src/transport/connection-health'
import { subscribeToDesktopNotifications } from '../src/notifications/mobile-notifications'
import type { ConnectionState, HostProfile } from '../src/transport/types'
import { triggerMediumImpact } from '../src/platform/haptics'
import { OrcaLogo } from '../src/components/OrcaLogo'
import { StatusDot } from '../src/components/StatusDot'
import { TextInputModal } from '../src/components/TextInputModal'
import { ActionSheetModal, type ActionSheetAction } from '../src/components/ActionSheetModal'
import { ConfirmModal } from '../src/components/ConfirmModal'
import { setCachedWorktrees, getCachedWorktrees } from '../src/cache/worktree-cache'
import { loadHomeSnapshot, saveHomeSnapshot } from '../src/cache/home-snapshot-cache'
import { colors, spacing, radii } from '../src/theme/mobile-theme'

function endpointLabel(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    return `${url.hostname}${url.port ? `:${url.port}` : ''}`
  } catch {
    return endpoint
  }
}

type StatsSummary = {
  totalAgentsSpawned: number
  totalPRsCreated: number
  totalAgentTimeMs: number
  firstEventAt: number | null
}

type WorktreeSummary = {
  worktreeId: string
  repo: string
  branch: string
  displayName: string
  liveTerminalCount: number
  status?: 'working' | 'active' | 'permission' | 'done' | 'inactive'
}

type HostWorktreeInfo = {
  hostId: string
  totalWorktrees: number
  activeCount: number
  lastActiveWorktree: WorktreeSummary | null
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000)
  const totalHours = Math.floor(totalMinutes / 60)
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  if (days > 0) return `${days}d ${hours}h`
  const minutes = totalMinutes % 60
  if (totalHours > 0) return `${totalHours}h ${minutes}m`
  return `${totalMinutes}m`
}

function fetchStats(
  client: RpcClient,
  setStats: (s: StatsSummary) => void,
  disposed: () => boolean
) {
  client
    .sendRequest('stats.summary')
    .then((response) => {
      if (disposed()) return
      if (response.ok) {
        setStats(response.result as StatsSummary)
      }
    })
    .catch(() => {})
}

function fetchWorktreeInfo(
  client: RpcClient,
  hostId: string,
  setInfo: (
    updater: (prev: Record<string, HostWorktreeInfo>) => Record<string, HostWorktreeInfo>
  ) => void,
  disposed: () => boolean
) {
  // Why: only seed an empty zeroed entry when this host has no prior info
  // at all (e.g., first ever load before any cache hydration). On a
  // transient failure for a host that already has cached data, leave the
  // cached entry alone so the Resume card and host-meta line don't
  // momentarily flip to "0 worktrees" / disappear during reconnects.
  const markLoadedIfMissing = () => {
    setInfo((prev) => {
      if (prev[hostId]) return prev
      return {
        ...prev,
        [hostId]: {
          hostId,
          totalWorktrees: 0,
          activeCount: 0,
          lastActiveWorktree: null
        }
      }
    })
  }

  client
    .sendRequest('worktree.ps')
    .then((response) => {
      if (disposed()) return
      if (response.ok) {
        const result = response.result as { worktrees: WorktreeSummary[] }
        const worktrees = result.worktrees ?? []
        setCachedWorktrees(hostId, worktrees)
        const activeStatuses = new Set(['working', 'active', 'permission'])
        const active = worktrees.filter((w) => w.status && activeStatuses.has(w.status))
        const lastActive = active.length > 0 ? active[0] : (worktrees[0] ?? null)
        setInfo((prev) => ({
          ...prev,
          [hostId]: {
            hostId,
            totalWorktrees: worktrees.length,
            activeCount: active.length,
            lastActiveWorktree: lastActive
          }
        }))
      } else {
        markLoadedIfMissing()
      }
    })
    .catch(() => {
      if (!disposed()) markLoadedIfMissing()
    })
}

function fetchAccountsSnapshot(
  client: RpcClient,
  hostId: string,
  setSnapshots: (
    updater: (prev: Record<string, AccountsSnapshot>) => Record<string, AccountsSnapshot>
  ) => void,
  disposed: () => boolean
) {
  client
    .sendRequest('accounts.list')
    .then((response) => {
      if (disposed()) return
      if (response.ok) {
        const snapshot = response.result as AccountsSnapshot
        setSnapshots((prev) => ({ ...prev, [hostId]: snapshot }))
      }
    })
    .catch(() => {})
}

// Why: repo names get a stable color derived from hashing, matching the
// host detail page's colored dots for visual consistency.
const REPO_COLORS = ['#8b5cf6', '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#06b6d4']
function repoColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  return REPO_COLORS[Math.abs(hash) % REPO_COLORS.length]
}

export default function HomeScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [hosts, setHosts] = useState<HostProfile[]>([])
  const [actionTarget, setActionTarget] = useState<HostProfile | null>(null)
  const [renameTarget, setRenameTarget] = useState<HostProfile | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<HostProfile | null>(null)
  const [hostStates, setHostStates] = useState<Record<string, ConnectionState>>({})
  const [hostAttempts, setHostAttempts] = useState<Record<string, number>>({})
  const [hostLastConnected, setHostLastConnected] = useState<Record<string, number | null>>({})
  const [stats, setStats] = useState<StatsSummary | null>(null)
  const [worktreeInfo, setWorktreeInfo] = useState<Record<string, HostWorktreeInfo>>({})
  const [accountsByHost, setAccountsByHost] = useState<Record<string, AccountsSnapshot>>({})
  const [lastVisited, setLastVisited] = useState<{ hostId: string; worktreeId: string } | null>(
    null
  )

  // Why: read shared clients from the per-host store. Replaces the prior
  // pattern of opening N independent WebSockets here. See
  // docs/mobile-shared-client-per-host.md.
  const hostIds = useMemo(() => hosts.map((h) => h.id), [hosts])
  const allClients = useAllHostClients(hostIds)
  const closeHostClient = useCloseHost()
  const forceReconnectHost = useForceReconnect()
  const primeHosts = usePrimeHosts()
  // Why: feed the loaded HostProfiles into the provider's prime cache as
  // soon as we have them. This avoids a second Keychain pass inside
  // openEntry on cold start (which serialised behind the first one and
  // showed up as multi-second connect latency).
  useEffect(() => {
    if (hosts.length > 0) primeHosts(hosts)
  }, [hosts, primeHosts])
  const allClientsRef = useRef<Array<{ hostId: string; client: RpcClient }>>([])
  useEffect(() => {
    allClientsRef.current = allClients.map((entry) => ({
      hostId: entry.hostId,
      client: entry.client
    }))
  }, [allClients])

  // Why: hydrate the home page from a persisted snapshot on cold-start so
  // Resume + Account-usage cards paint immediately with last-known data
  // instead of flashing empty for ~1s while the WebSocket reconnects.
  // Stream/list responses overwrite this seed in place when they arrive.
  const hydratedRef = useRef(false)
  useEffect(() => {
    if (hydratedRef.current) return
    hydratedRef.current = true
    let cancelled = false
    void loadHomeSnapshot().then((snap) => {
      if (cancelled || !snap) return
      setWorktreeInfo((prev) => (Object.keys(prev).length > 0 ? prev : snap.worktreeInfo))
      setAccountsByHost((prev) => (Object.keys(prev).length > 0 ? prev : snap.accountsByHost))
      for (const [hostId, info] of Object.entries(snap.worktreeInfo)) {
        const wt = info.lastActiveWorktree
        if (wt) {
          // Why: also seed the in-memory worktree cache so resumeWorktree's
          // lastVisited fast-path can find the cached worktree object.
          setCachedWorktrees(hostId, [wt])
        }
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Why: persist the merged snapshot whenever either piece updates so the
  // next cold-start has fresh seed data. The cache module debounces writes
  // internally so a flurry of streamed updates doesn't hammer disk.
  useEffect(() => {
    if (Object.keys(worktreeInfo).length === 0 && Object.keys(accountsByHost).length === 0) {
      return
    }
    saveHomeSnapshot({
      worktreeInfo,
      accountsByHost,
      savedAt: Date.now()
    })
  }, [worktreeInfo, accountsByHost])

  useFocusEffect(
    useCallback(() => {
      let stale = false
      void loadHosts().then((h) => {
        if (!stale) setHosts(h)
      })
      void AsyncStorage.getItem('orca:last-visited-worktree').then((raw) => {
        if (stale || !raw) return
        try {
          setLastVisited(JSON.parse(raw))
        } catch {}
      })
      for (const entry of allClientsRef.current) {
        if (entry.client.getState() === 'connected') {
          fetchStats(entry.client, setStats, () => stale)
          fetchWorktreeInfo(entry.client, entry.hostId, setWorktreeInfo, () => stale)
          fetchAccountsSnapshot(entry.client, entry.hostId, setAccountsByHost, () => stale)
        }
      }
      return () => {
        stale = true
      }
    }, [])
  )

  const sortedHosts = useMemo(
    () => [...hosts].sort((a, b) => b.lastConnected - a.lastConnected),
    [hosts]
  )

  // Why: mirror per-host connection state into hostStates so existing
  // render code (status dots, connecting indicators) keeps working.
  useEffect(() => {
    setHostAttempts((prev) => {
      const next: Record<string, number> = { ...prev }
      let changed = false
      for (const entry of allClients) {
        const a = entry.client.getReconnectAttempt()
        if (next[entry.hostId] !== a) {
          next[entry.hostId] = a
          changed = true
        }
      }
      return changed ? next : prev
    })
    setHostLastConnected((prev) => {
      const next: Record<string, number | null> = { ...prev }
      let changed = false
      for (const entry of allClients) {
        const t = entry.client.getLastConnectedAt()
        if (next[entry.hostId] !== t) {
          next[entry.hostId] = t
          changed = true
        }
      }
      return changed ? next : prev
    })
    setHostStates((prev) => {
      const next: Record<string, ConnectionState> = { ...prev }
      let changed = false
      const liveIds = new Set(allClients.map((e) => e.hostId))
      for (const entry of allClients) {
        if (next[entry.hostId] !== entry.state) {
          next[entry.hostId] = entry.state
          changed = true
        }
      }
      // Why: when a paired host disappears from allClients (because the
      // user tapped Disconnect, or the host record was invalid) the card
      // must reflect that. We only force-update hosts whose state was
      // already tracked — otherwise the initial-acquire frame (entry not
      // yet materialised) would briefly flip every host to 'disconnected'.
      for (const host of hosts) {
        if (liveIds.has(host.id)) continue
        if (!host.publicKeyB64 || !host.deviceToken) {
          if (next[host.id] !== 'auth-failed') {
            next[host.id] = 'auth-failed'
            changed = true
          }
          continue
        }
        const prevState = next[host.id]
        if (prevState && prevState !== 'disconnected' && prevState !== 'auth-failed') {
          next[host.id] = 'disconnected'
          changed = true
        }
      }
      // Drop entries for hosts we no longer track at all.
      for (const id of Object.keys(next)) {
        if (!liveIds.has(id) && hosts.some((h) => h.id === id) === false) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [allClients, hosts])

  // Why: per-host streaming subscriptions (notifications + accounts) and
  // one-shot stats fetches when each host transitions to 'connected'.
  // Runs once per (hostId, client) pair and tears down when that pair
  // changes. The provider keeps the underlying socket open across
  // resubscription cycles so this is cheap.
  useEffect(() => {
    const cleanups: Array<() => void> = []
    for (const entry of allClients) {
      let unsubNotif: (() => void) | null = null
      let unsubAccounts: (() => void) | null = null
      let statsFetched = false
      const wireUp = (state: ConnectionState) => {
        if (state === 'connected') {
          if (!unsubNotif) {
            unsubNotif = subscribeToDesktopNotifications(entry.client)
          }
          if (!unsubAccounts) {
            unsubAccounts = entry.client.subscribe('accounts.subscribe', null, (payload) => {
              if (!payload || typeof payload !== 'object') return
              const evt = payload as { type?: string; snapshot?: AccountsSnapshot }
              if ((evt.type === 'ready' || evt.type === 'snapshot') && evt.snapshot) {
                setAccountsByHost((prev) => ({ ...prev, [entry.hostId]: evt.snapshot! }))
              }
            })
          }
          if (!statsFetched) {
            statsFetched = true
            fetchStats(entry.client, setStats, () => false)
            fetchWorktreeInfo(entry.client, entry.hostId, setWorktreeInfo, () => false)
          }
        } else {
          if (unsubNotif) {
            unsubNotif()
            unsubNotif = null
          }
          if (unsubAccounts) {
            unsubAccounts()
            unsubAccounts = null
          }
        }
      }
      wireUp(entry.state)
      const unsubState = entry.client.onStateChange(wireUp)
      cleanups.push(() => {
        unsubState()
        unsubNotif?.()
        unsubAccounts?.()
      })
    }
    return () => {
      for (const c of cleanups) c()
    }
    // Why: depend on the host-id set, not the whole allClients array, so
    // resubscriptions don't fire on every render that produces a new
    // array reference. Client identity is stable per hostId for the
    // lifetime of the underlying transport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    allClients
      .map((e) => e.hostId)
      .sort()
      .join(',')
  ])

  // Why: prefer the worktree the user last opened on this device so the
  // "Resume" card reflects their mobile session history, not just the
  // desktop's most-recently-outputting worktree.
  // Why: rendering used to be gated on hostStates === 'connected', which
  // caused the Resume card to vanish for ~1s on every cold-start /
  // resume-from-background while the WebSocket reconnected, even though we
  // had perfectly good cached worktree data. Now the card stays visible as
  // long as we have a cached lastActiveWorktree for any known host; the
  // tap target is still the same and a fresher snapshot from the live RPC
  // overwrites the card's contents in place when it lands.
  const resumeWorktree = useMemo(() => {
    // Why: only surface Resume for hosts that are currently connected.
    // Showing a stale cached worktree for a disconnected host is
    // misleading — the user would tap into a session route that can't
    // load anything until the host reconnects. Once the host reconnects,
    // the card reappears with fresh data.
    if (lastVisited && hostStates[lastVisited.hostId] === 'connected') {
      const cached = getCachedWorktrees(lastVisited.hostId) as WorktreeSummary[] | null
      const match = cached?.find((w) => w.worktreeId === lastVisited.worktreeId)
      if (match) return { hostId: lastVisited.hostId, worktree: match }
    }
    for (const host of sortedHosts) {
      if (hostStates[host.id] !== 'connected') continue
      const info = worktreeInfo[host.id]
      if (info?.lastActiveWorktree) {
        return { hostId: host.id, worktree: info.lastActiveWorktree }
      }
    }
    return null
  }, [sortedHosts, hostStates, worktreeInfo, lastVisited])

  // Why: only show the Account usage section for hosts that are currently
  // connected. Showing stale cached usage for a disconnected host implies
  // live data; better to hide until the host reconnects and we can refresh.
  const accountsHosts = useMemo(() => {
    const items: Array<{ host: HostProfile; snapshot: AccountsSnapshot }> = []
    for (const host of sortedHosts) {
      if (hostStates[host.id] !== 'connected') continue
      const snap = accountsByHost[host.id]
      if (!snap) continue
      const hasClaude = snap.claude.accounts.length > 0
      const hasCodex = snap.codex.accounts.length > 0
      if (hasClaude || hasCodex) items.push({ host, snapshot: snap })
    }
    return items
  }, [sortedHosts, hostStates, accountsByHost])

  async function handleRename(newName: string) {
    if (!renameTarget) return
    try {
      await renameHost(renameTarget.id, newName)
      setRenameTarget(null)
      setHosts(await loadHosts())
    } catch {
      setRenameTarget(null)
    }
  }

  async function handleRemove() {
    if (!confirmRemove) return
    try {
      // Why: close the shared client first so the WebSocket is gone
      // before the host record disappears from loadHosts().
      closeHostClient(confirmRemove.id)
      await removeHost(confirmRemove.id)
      setConfirmRemove(null)
      setHosts(await loadHosts())
    } catch {
      setConfirmRemove(null)
    }
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* ─── Top bar ─── */}
      <View style={styles.topBar}>
        <View style={styles.brandLockup}>
          <View style={styles.logoMark}>
            <OrcaLogo size={18} />
          </View>
          <Text style={styles.brandName}>Orca</Text>
        </View>
        <Pressable
          style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
          onPress={() => router.push('/settings')}
        >
          <Settings size={18} color={colors.textSecondary} />
        </Pressable>
      </View>

      {hosts.length === 0 ? (
        /* ─── Empty state: onboarding ─── */
        <View style={[styles.emptyContainer, { paddingBottom: insets.bottom }]}>
          <View style={styles.emptyHero}>
            <Text style={styles.emptyTitle}>Connect your desktop</Text>
            <Text style={styles.emptyBody}>
              Pair with Orca on your computer to check on your agents, jump into any terminal, and
              drive work from your phone.
            </Text>
            <Pressable style={styles.primaryButton} onPress={() => router.push('/pair-scan')}>
              <QrCode size={17} color={colors.bgBase} />
              <Text style={styles.primaryButtonText}>Pair Desktop</Text>
            </Pressable>
          </View>

          <View style={styles.stepsSection}>
            <Text style={styles.sectionHeading}>How it works</Text>
            {ONBOARDING_STEPS.map((step, i) => (
              <View key={step.title} style={[styles.stepRow, i > 0 && styles.stepRowBorder]}>
                <View style={styles.stepNum}>
                  <Text style={styles.stepNumText}>{i + 1}</Text>
                </View>
                <View style={styles.stepText}>
                  <Text style={styles.stepTitle}>{step.title}</Text>
                  <Text style={styles.stepDesc}>{step.desc}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      ) : (
        /* ─── Populated state ─── */
        <FlatList
          data={sortedHosts}
          keyExtractor={(h) => h.id}
          // Why: edge-to-edge — let the list scroll under the system nav bar
          // but reserve insets.bottom so the last row stays reachable above
          // the Samsung 3-button nav / iOS home indicator.
          contentContainerStyle={[styles.list, { paddingBottom: spacing.xl + insets.bottom }]}
          ListHeaderComponent={
            <View>
              <View style={styles.hero}>
                <Text style={styles.heroTitle}>Welcome back</Text>
              </View>

              {stats && (
                <View style={styles.statsRow}>
                  <View style={styles.statCard}>
                    <View style={styles.statIcon}>
                      <Bot size={14} color={colors.textMuted} />
                    </View>
                    <Text style={styles.statValue}>
                      {stats.totalAgentsSpawned.toLocaleString()}
                    </Text>
                    <Text style={styles.statLabel}>Agents spawned</Text>
                  </View>
                  <View style={styles.statCard}>
                    <View style={styles.statIcon}>
                      <Clock size={14} color={colors.textMuted} />
                    </View>
                    <Text style={styles.statValue}>{formatDuration(stats.totalAgentTimeMs)}</Text>
                    <Text style={styles.statLabel}>Agent time</Text>
                  </View>
                  <View style={styles.statCard}>
                    <View style={styles.statIcon}>
                      <GitPullRequest size={14} color={colors.textMuted} />
                    </View>
                    <Text style={styles.statValue}>{stats.totalPRsCreated.toLocaleString()}</Text>
                    <Text style={styles.statLabel}>PRs created</Text>
                  </View>
                </View>
              )}

              <Text style={styles.sectionHeading}>Desktops</Text>
            </View>
          }
          ItemSeparatorComponent={CardGap}
          renderItem={({ item }) => {
            const state = hostStates[item.id] ?? 'connecting'
            const attempts = hostAttempts[item.id] ?? 0
            const lastConnectedAt = hostLastConnected[item.id] ?? null
            const connected = state === 'connected'
            const info = worktreeInfo[item.id]
            const verdict = classifyConnection({
              state,
              reconnectAttempts: attempts,
              lastConnectedAt
            })
            const isError =
              verdict.kind === 'warning' ||
              verdict.kind === 'unreachable' ||
              verdict.kind === 'auth-failed'
            return (
              <Pressable
                style={({ pressed }) => [styles.hostCard, pressed && styles.hostCardPressed]}
                onPress={() => router.push(`/h/${item.id}`)}
                onLongPress={() => {
                  triggerMediumImpact()
                  setActionTarget(item)
                }}
                delayLongPress={400}
              >
                <View style={styles.hostIcon}>
                  <Monitor
                    size={20}
                    color={connected ? colors.textPrimary : colors.textSecondary}
                  />
                </View>
                <View style={styles.hostMain}>
                  <Text
                    style={[styles.hostName, !connected && { color: colors.textSecondary }]}
                    numberOfLines={1}
                  >
                    {item.name}
                  </Text>
                  <View style={styles.hostMeta}>
                    <StatusDot state={state} verdict={verdict} />
                    <Text style={[styles.hostMetaItem, isError && { color: colors.statusRed }]}>
                      {verdict.label}
                      {connected && info
                        ? ` · ${info.totalWorktrees} worktree${info.totalWorktrees !== 1 ? 's' : ''}${info.activeCount > 0 ? ` · ${info.activeCount} active` : ''}`
                        : ''}
                    </Text>
                  </View>
                </View>
                <ChevronRight size={16} color={colors.textMuted} />
              </Pressable>
            )
          }}
          ListFooterComponent={
            <View>
              {/* ─── Resume card ─── */}
              {resumeWorktree ? (
                <>
                  <Text style={[styles.sectionHeading, { marginTop: spacing.xl }]}>Resume</Text>
                  <Pressable
                    style={({ pressed }) => [styles.resumeCard, pressed && styles.hostCardPressed]}
                    onPress={() =>
                      router.push(
                        `/h/${resumeWorktree.hostId}/session/${encodeURIComponent(resumeWorktree.worktree.worktreeId)}`
                      )
                    }
                  >
                    <View style={styles.resumeIcon}>
                      <Terminal size={18} color={colors.textSecondary} />
                    </View>
                    <View style={styles.resumeMain}>
                      <Text style={styles.resumeTitle} numberOfLines={1}>
                        {resumeWorktree.worktree.displayName}
                      </Text>
                      <View style={styles.resumeSub}>
                        <View
                          style={[
                            styles.repoDot,
                            { backgroundColor: repoColor(resumeWorktree.worktree.repo) }
                          ]}
                        />
                        <Text style={styles.resumeSubText} numberOfLines={1}>
                          {resumeWorktree.worktree.repo}
                          {'  ·  '}
                          {resumeWorktree.worktree.branch}
                        </Text>
                      </View>
                    </View>
                    <ChevronRight size={16} color={colors.textMuted} />
                  </Pressable>
                </>
              ) : null}

              {/* ─── Account usage ─── */}
              {accountsHosts.length > 0 ? (
                <>
                  <Text style={[styles.sectionHeading, { marginTop: spacing.xl }]}>
                    Account usage
                  </Text>
                  {accountsHosts.map(({ host, snapshot }) => {
                    const claudeActiveId = snapshot.claude.activeAccountId
                    const claudeActive =
                      snapshot.claude.accounts.find((a) => a.id === claudeActiveId) ?? null
                    const codexActiveId = snapshot.codex.activeAccountId
                    const codexActive =
                      snapshot.codex.accounts.find((a) => a.id === codexActiveId) ?? null
                    const showHostName = accountsHosts.length > 1
                    return (
                      <Pressable
                        key={host.id}
                        style={({ pressed }) => [
                          styles.accountsCard,
                          pressed && styles.hostCardPressed
                        ]}
                        onPress={() => router.push(`/h/${host.id}/accounts`)}
                      >
                        {showHostName ? (
                          <Text style={styles.accountsHostLabel} numberOfLines={1}>
                            {host.name}
                          </Text>
                        ) : null}
                        {(['claude', 'codex'] as ProviderKey[]).map((provider) => {
                          const active = provider === 'claude' ? claudeActive : codexActive
                          const accounts =
                            provider === 'claude'
                              ? snapshot.claude.accounts
                              : snapshot.codex.accounts
                          if (accounts.length === 0) return null
                          const limits = getActiveProviderRateLimits(snapshot, provider)
                          const isFetching =
                            limits?.status === 'fetching' || limits?.status === 'idle'
                          const unavailable =
                            limits == null ||
                            limits.status === 'unavailable' ||
                            limits.status === 'error'
                          return (
                            <View key={provider} style={styles.accountsRow}>
                              <View style={styles.accountsIcon}>
                                {provider === 'claude' ? (
                                  <ClaudeIcon size={18} />
                                ) : (
                                  <OpenAIIcon size={18} color={colors.textPrimary} />
                                )}
                              </View>
                              <View style={styles.accountsInfo}>
                                <Text style={styles.accountsEmail} numberOfLines={1}>
                                  {active?.email ?? 'System default'}
                                </Text>
                                <View style={styles.accountsBars}>
                                  <UsageBar
                                    label="5h"
                                    usedPercent={limits?.session?.usedPercent ?? null}
                                    unavailable={unavailable}
                                    loading={isFetching && limits?.session == null}
                                  />
                                  <UsageBar
                                    label="7d"
                                    usedPercent={limits?.weekly?.usedPercent ?? null}
                                    unavailable={unavailable}
                                    loading={isFetching && limits?.weekly == null}
                                  />
                                </View>
                              </View>
                            </View>
                          )
                        })}
                      </Pressable>
                    )
                  })}
                </>
              ) : null}

              {/* ─── Quick actions ─── */}
              <Text style={[styles.sectionHeading, { marginTop: spacing.xl }]}>Quick Actions</Text>
              <View style={styles.quickActions}>
                <Pressable
                  style={({ pressed }) => [styles.quickAction, pressed && styles.hostCardPressed]}
                  onPress={() => router.push('/pair-scan')}
                >
                  <View style={styles.quickActionIcon}>
                    <QrCode size={16} color={colors.textSecondary} />
                  </View>
                  <Text style={styles.quickActionLabel}>Pair Desktop</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.quickAction, pressed && styles.hostCardPressed]}
                  onPress={() => {
                    const connectedHost = sortedHosts.find((h) => hostStates[h.id] === 'connected')
                    if (connectedHost) {
                      router.push(`/h/${connectedHost.id}?action=newWorktree`)
                    }
                  }}
                >
                  <View style={styles.quickActionIcon}>
                    <Plus size={16} color={colors.textSecondary} />
                  </View>
                  <Text style={styles.quickActionLabel}>New Worktree</Text>
                </Pressable>
              </View>
            </View>
          }
        />
      )}

      {/* ─── Action sheets (shared by both states) ─── */}
      <ActionSheetModal
        visible={actionTarget != null}
        title={actionTarget?.name}
        message={actionTarget ? endpointLabel(actionTarget.endpoint) : undefined}
        actions={(() => {
          const host = actionTarget
          if (!host) return []
          const state = hostStates[host.id] ?? 'connecting'
          const isLive =
            state === 'connected' ||
            state === 'connecting' ||
            state === 'handshaking' ||
            state === 'reconnecting'
          // Why: "Reconnect" implies "you were connected, try again". If
          // the client has never reached 'connected' this session (cold
          // start, unreachable host, or after Disconnect) the action is
          // functionally a fresh Connect — using the right verb makes
          // the affordance match what tapping it actually does.
          const hasEverConnected = (hostLastConnected[host.id] ?? null) != null
          const items: ActionSheetAction[] = []
          items.push({
            label: hasEverConnected && isLive ? 'Reconnect' : 'Connect',
            icon: RefreshCw,
            onPress: () => {
              setActionTarget(null)
              void forceReconnectHost(host.id)
            }
          })
          if (isLive) {
            items.push({
              label: 'Disconnect',
              icon: PowerOff,
              onPress: () => {
                setActionTarget(null)
                closeHostClient(host.id)
              }
            })
          }
          items.push({
            label: 'Rename',
            icon: Edit3,
            onPress: () => {
              setActionTarget(null)
              setRenameTarget(host)
            }
          })
          items.push({
            label: 'Remove',
            destructive: true,
            onPress: () => {
              setActionTarget(null)
              setConfirmRemove(host)
            }
          })
          return items
        })()}
        onClose={() => setActionTarget(null)}
      />

      <TextInputModal
        visible={renameTarget != null}
        title="Rename Host"
        message="Enter a new name for this host."
        defaultValue={renameTarget?.name ?? ''}
        placeholder="Host name"
        onSubmit={(name) => void handleRename(name)}
        onCancel={() => setRenameTarget(null)}
      />

      <ConfirmModal
        visible={confirmRemove != null}
        title="Remove Host"
        message={`Remove "${confirmRemove?.name}"? You can re-pair later.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => void handleRemove()}
        onCancel={() => setConfirmRemove(null)}
      />
    </SafeAreaView>
  )
}

function CardGap() {
  return <View style={styles.cardGap} />
}

const ONBOARDING_STEPS = [
  {
    title: 'Open Orca desktop',
    desc: 'Go to Settings → Mobile and generate a pairing QR code.'
  },
  {
    title: 'Scan the code',
    desc: 'Tap the button above to open the scanner. Point at the QR code on your screen.'
  },
  {
    title: "You're connected",
    desc: 'Your desktop will appear here. Everything is encrypted end-to-end.'
  }
]

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },

  /* ─── Top bar ─── */
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md
  },
  brandLockup: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0
  },
  logoMark: {
    marginRight: spacing.sm
  },
  brandName: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: '700'
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center'
  },
  iconButtonPressed: {
    backgroundColor: colors.bgRaised
  },

  /* ─── Hero / greeting ─── */
  hero: {
    paddingTop: spacing.md,
    paddingBottom: spacing.lg
  },
  heroTitle: {
    color: colors.textPrimary,
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: -0.3
  },

  /* ─── Stat cards ─── */
  statsRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: spacing.xl
  },
  statCard: {
    flex: 1,
    backgroundColor: 'rgba(26,26,26,0.6)',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: spacing.md
  },
  statIcon: {
    width: 26,
    height: 26,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.04)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6
  },
  statValue: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.3
  },
  statLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '500',
    marginTop: 2
  },

  /* ─── Section heading ─── */
  sectionHeading: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xs
  },

  /* ─── List ─── */
  list: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl
  },
  cardGap: {
    height: spacing.sm
  },

  /* ─── Host cards ─── */
  hostCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    paddingVertical: 14,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  hostCardPressed: {
    backgroundColor: colors.bgRaised
  },
  hostIcon: {
    width: 46,
    height: 46,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    marginRight: 14,
    position: 'relative'
  },
  hostMain: {
    flex: 1,
    minWidth: 0,
    marginRight: spacing.sm
  },
  hostName: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 20
  },
  hostMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 3
  },
  hostMetaItem: {
    fontSize: 12,
    color: colors.textSecondary
  },
  hostMetaDot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: colors.textMuted,
    marginHorizontal: 8
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5
  },

  /* ─── Resume card ─── */
  resumeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    paddingVertical: 14
  },
  resumeIcon: {
    width: 46,
    height: 46,
    borderRadius: 13,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14
  },
  resumeMain: {
    flex: 1,
    minWidth: 0
  },
  resumeTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary
  },
  resumeSub: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 3
  },
  repoDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5
  },
  resumeSubText: {
    fontSize: 12,
    color: colors.textSecondary,
    flex: 1
  },

  /* ─── Account usage ─── */
  accountsCard: {
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    gap: spacing.sm,
    marginBottom: spacing.sm
  },
  accountsHostLabel: {
    fontSize: 11,
    color: colors.textMuted,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.4
  },
  accountsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2
  },
  accountsIcon: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  accountsInfo: {
    flex: 1,
    minWidth: 0,
    gap: 2
  },
  accountsEmail: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary
  },
  accountsBars: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: 4
  },

  /* ─── Quick actions ─── */
  quickActions: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  quickAction: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: 'center',
    gap: 10
  },
  quickActionIcon: {
    width: 28,
    height: 28,
    borderRadius: 9,
    backgroundColor: 'rgba(255,255,255,0.04)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  quickActionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary
  },

  /* ─── Empty state ─── */
  emptyContainer: {
    flex: 1
  },
  emptyGreeting: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm
  },
  emptyHero: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingBottom: 40
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.textPrimary,
    textAlign: 'center',
    marginBottom: 10
  },
  emptyBody: {
    fontSize: 15,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.textPrimary,
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: radii.card
  },
  primaryButtonText: {
    color: colors.bgBase,
    fontSize: 15,
    fontWeight: '700'
  },

  /* ─── Onboarding steps ─── */
  stepsSection: {
    paddingHorizontal: spacing.xl
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
    paddingVertical: spacing.lg
  },
  stepRowBorder: {
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle
  },
  stepNum: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1
  },
  stepNumText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textSecondary
  },
  stepText: {
    flex: 1
  },
  stepTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: 3
  },
  stepDesc: {
    fontSize: 12,
    color: colors.textMuted,
    lineHeight: 17
  }
})
