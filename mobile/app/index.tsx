import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { View, Text, StyleSheet, Pressable, FlatList, Alert } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter, useFocusEffect } from 'expo-router'
import {
  QrCode,
  Settings,
  ChevronRight,
  Terminal,
  Plus,
  RefreshCw,
  PowerOff,
  Edit3,
  ListTodo
} from 'lucide-react-native'
import { ClaudeIcon, OpenAIIcon } from '../src/components/AgentIcons'
import {
  type AccountsSnapshot,
  type ProviderKey,
  getActiveProviderRateLimits,
  getUsageBarState,
  hasActiveProviderUsage,
  hasRenderableUsage,
  UsageBar
} from '../src/components/AccountUsage'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { loadHosts } from '../src/transport/host-store'
import { removeHostAndCloseClient } from '../src/transport/host-removal-lifecycle'
import { pickResumeWorktree } from '../src/worktree/resume-worktree'
import type { RpcClient } from '../src/transport/rpc-client'
import {
  useAllHostClients,
  useCloseHost,
  useForceReconnect,
  usePrimeHosts
} from '../src/transport/client-context'
import { classifyConnection } from '../src/transport/connection-health'
import { subscribeToDesktopNotifications } from '../src/notifications/mobile-notifications'
import {
  loadMobileOnboardingSteps,
  mobileOnboardingDestination
} from '../src/onboarding/mobile-onboarding-plan'
import type { ConnectionState, HostProfile } from '../src/transport/types'
import { triggerMediumImpact } from '../src/platform/haptics'
import { OrcaLogo } from '../src/components/OrcaLogo'
import { MobileHostCard } from '../src/components/MobileHostCard'
import { TaskProviderLogo } from '../src/components/TaskProviderLogo'
import { ActionSheetModal, type ActionSheetAction } from '../src/components/ActionSheetModal'
import { ConfirmModal } from '../src/components/ConfirmModal'
import { setCachedWorktrees, getCachedWorktrees } from '../src/cache/worktree-cache'
import { loadHomeSnapshot, saveHomeSnapshot } from '../src/cache/home-snapshot-cache'
import { colors, spacing, radii } from '../src/theme/mobile-theme'
import {
  filterAvailableTaskProviders,
  normalizeVisibleTaskProviders,
  type TaskProvider
} from '../src/tasks/mobile-task-providers'
import { useResponsiveLayout } from '../src/layout/responsive-layout'

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
  // The worktree the desktop currently has focused (exactly one is true).
  isActive?: boolean
  // Last terminal-output time (ms); breaks ties when nothing is focused.
  lastOutputAt?: number
}

type HostWorktreeInfo = {
  hostId: string
  totalWorktrees: number
  activeCount: number
  lastActiveWorktree: WorktreeSummary | null
}

type HomeTaskSettings = {
  visibleTaskProviders?: unknown
}

type HomePreflightStatus = {
  glab?: { installed?: boolean }
}

type HomeLinearStatus = {
  connected?: boolean
}

const TASK_PROVIDER_LABELS: Record<TaskProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  linear: 'Linear'
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000)
  const totalHours = Math.floor(totalMinutes / 60)
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  if (days > 0) {
    return `${days}d ${hours}h`
  }
  const minutes = totalMinutes % 60
  if (totalHours > 0) {
    return `${totalHours}h ${minutes}m`
  }
  return `${totalMinutes}m`
}

// Why: stable per-instance RpcClient identity so wireUp's dep key changes when forceReconnect swaps the client, re-attaching listeners.
const clientIdentities = new WeakMap<RpcClient, number>()
let nextClientIdentity = 1
function clientKey(client: RpcClient): number {
  let id = clientIdentities.get(client)
  if (id == null) {
    id = nextClientIdentity++
    clientIdentities.set(client, id)
  }
  return id
}

function fetchStats(
  client: RpcClient,
  setStats: (s: StatsSummary) => void,
  disposed: () => boolean
) {
  client
    .sendRequest('stats.summary')
    .then((response) => {
      if (disposed()) {
        return
      }
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
  // Why: only seed a zeroed entry when the host has no prior info; keep cached data on transient failure so counts don't flip to 0 during reconnects.
  const markLoadedIfMissing = () => {
    setInfo((prev) => {
      if (prev[hostId]) {
        return prev
      }
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
    // Why: worktree.ps defaults to 200 and silently truncates; request all so counts are accurate.
    .sendRequest('worktree.ps', { limit: 10000 })
    .then((response) => {
      if (disposed()) {
        return
      }
      if (response.ok) {
        const result = response.result as { worktrees: WorktreeSummary[] }
        const worktrees = result.worktrees ?? []
        setCachedWorktrees(hostId, worktrees)
        const activeStatuses = new Set(['working', 'active', 'permission'])
        const active = worktrees.filter((w) => w.status && activeStatuses.has(w.status))
        // Mirror the desktop's focused workspace (see pickResumeWorktree).
        const lastActive = pickResumeWorktree(worktrees)
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
      if (!disposed()) {
        markLoadedIfMissing()
      }
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
      if (disposed()) {
        return
      }
      if (response.ok) {
        const snapshot = response.result as AccountsSnapshot
        setSnapshots((prev) => ({ ...prev, [hostId]: snapshot }))
      }
    })
    .catch(() => {})
}

function fetchTaskProviders(
  client: RpcClient,
  hostId: string,
  setProviders: (
    updater: (prev: Record<string, TaskProvider[]>) => Record<string, TaskProvider[]>
  ) => void,
  disposed: () => boolean
) {
  Promise.all([
    client.sendRequest('settings.get'),
    client.sendRequest('preflight.check'),
    client.sendRequest('linear.status')
  ])
    .then(([settingsResponse, preflightResponse, linearResponse]) => {
      if (disposed()) {
        return
      }
      const settings = settingsResponse.ok
        ? (((settingsResponse.result as { settings?: HomeTaskSettings }).settings ??
            {}) as HomeTaskSettings)
        : {}
      const preflight = preflightResponse.ok
        ? (preflightResponse.result as HomePreflightStatus)
        : null
      const linear = linearResponse.ok ? (linearResponse.result as HomeLinearStatus) : null
      const providers = filterAvailableTaskProviders(
        normalizeVisibleTaskProviders(settings.visibleTaskProviders),
        {
          gitlabInstalled: preflight?.glab?.installed === true,
          linearConnected: linear?.connected === true
        }
      )
      setProviders((prev) => ({ ...prev, [hostId]: providers }))
    })
    .catch(() => {
      if (disposed()) {
        return
      }
      setProviders((prev) => (prev[hostId] ? prev : { ...prev, [hostId]: ['github'] }))
    })
}

// Why: hash repo name to a stable color, matching the host detail page's dots.
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
  // Why: cap/center content on wide/tablet canvases so cards don't stretch edge-to-edge on iPad.
  const { isWideLayout, contentMaxWidth } = useResponsiveLayout()
  const [hosts, setHosts] = useState<HostProfile[]>([])
  const [actionTarget, setActionTarget] = useState<HostProfile | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<HostProfile | null>(null)
  const [hostStates, setHostStates] = useState<Record<string, ConnectionState>>({})
  const [hostAttempts, setHostAttempts] = useState<Record<string, number>>({})
  const [hostLastConnected, setHostLastConnected] = useState<Record<string, number | null>>({})
  const [stats, setStats] = useState<StatsSummary | null>(null)
  const [worktreeInfo, setWorktreeInfo] = useState<Record<string, HostWorktreeInfo>>({})
  const [accountsByHost, setAccountsByHost] = useState<Record<string, AccountsSnapshot>>({})
  const [taskProvidersByHost, setTaskProvidersByHost] = useState<Record<string, TaskProvider[]>>({})
  const [lastVisited, setLastVisited] = useState<{ hostId: string; worktreeId: string } | null>(
    null
  )
  // Why: focus can fire repeatedly while an async gate is pending; one probe per
  // mount avoids duplicate storage/permission reads and competing navigation.
  const onboardingOptInCheckedRef = useRef(false)

  // Why: shared clients from the per-host store, not N independent WebSockets. See docs/mobile-shared-client-per-host.md.
  const hostIds = useMemo(() => hosts.map((h) => h.id), [hosts])
  const allClients = useAllHostClients(hostIds)
  const hostPaths = useMemo(
    () => Object.fromEntries(allClients.map(({ hostId, path }) => [hostId, path])),
    [allClients]
  )
  const closeHostClient = useCloseHost()
  const forceReconnectHost = useForceReconnect()
  const primeHosts = usePrimeHosts()
  // Why: prime the cache with loaded HostProfiles to avoid a second serialized Keychain pass (multi-second connect latency) on cold start.
  useEffect(() => {
    if (hosts.length > 0) {
      primeHosts(hosts)
    }
  }, [hosts, primeHosts])
  const allClientsRef = useRef<Array<{ hostId: string; client: RpcClient }>>([])
  // Why: keep the focus callback stable (no refetch per render) while still exposing the latest host clients.
  allClientsRef.current = allClients.map((entry) => ({
    hostId: entry.hostId,
    client: entry.client
  }))

  // Why: hydrate from a persisted snapshot on cold-start so Resume + Account cards paint immediately instead of flashing empty.
  const hydratedRef = useRef(false)
  useEffect(() => {
    if (hydratedRef.current) {
      return
    }
    hydratedRef.current = true
    let cancelled = false
    void loadHomeSnapshot().then((snap) => {
      if (cancelled || !snap) {
        return
      }
      setWorktreeInfo((prev) => (Object.keys(prev).length > 0 ? prev : snap.worktreeInfo))
      setAccountsByHost((prev) => (Object.keys(prev).length > 0 ? prev : snap.accountsByHost))
      for (const [hostId, info] of Object.entries(snap.worktreeInfo)) {
        const wt = info.lastActiveWorktree
        if (wt) {
          // Why: seed the in-memory cache so resumeWorktree's lastVisited fast-path finds the worktree object.
          setCachedWorktrees(hostId, [wt])
        }
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Why: persist the merged snapshot on each update so the next cold-start has fresh seed data (cache debounces writes).
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
      void loadHosts().then(async (h) => {
        if (stale) {
          return
        }
        setHosts(h)
        if (h.length === 0 || onboardingOptInCheckedRef.current) {
          return
        }
        onboardingOptInCheckedRef.current = true
        const onboardingSteps = await loadMobileOnboardingSteps()
        if (stale) {
          return
        }
        if (onboardingSteps.length > 0) {
          router.replace(mobileOnboardingDestination(onboardingSteps))
        }
      })
      void AsyncStorage.getItem('orca:last-visited-worktree').then((raw) => {
        if (stale || !raw) {
          return
        }
        try {
          setLastVisited(JSON.parse(raw))
        } catch {}
      })
      for (const entry of allClientsRef.current) {
        if (entry.client.getState() === 'connected') {
          fetchStats(entry.client, setStats, () => stale)
          fetchWorktreeInfo(entry.client, entry.hostId, setWorktreeInfo, () => stale)
          fetchAccountsSnapshot(entry.client, entry.hostId, setAccountsByHost, () => stale)
          fetchTaskProviders(entry.client, entry.hostId, setTaskProvidersByHost, () => stale)
        }
      }
      return () => {
        stale = true
      }
    }, [router])
  )

  const sortedHosts = useMemo(
    () => [...hosts].sort((a, b) => b.lastConnected - a.lastConnected),
    [hosts]
  )

  // Why: mirror per-host connection state into hostStates so existing render code (status dots) keeps working.
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
      // Why: reflect hosts that dropped from allClients, but only if already tracked — else the initial-acquire frame flips all to 'disconnected'.
      for (const host of hosts) {
        if (liveIds.has(host.id)) {
          continue
        }
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

  // Per-host notif/accounts subs + one-shot stats on 'connected'; re-runs per (hostId, client) pair, socket stays open so it's cheap.
  useEffect(() => {
    const cleanups: Array<() => void> = []
    for (const entry of allClients) {
      let unsubNotif: (() => void) | null = null
      let unsubAccounts: (() => void) | null = null
      let statsFetched = false
      const wireUp = (state: ConnectionState) => {
        if (state === 'connected') {
          if (!unsubNotif) {
            unsubNotif = subscribeToDesktopNotifications(entry.client, entry.hostId)
          }
          if (!unsubAccounts) {
            unsubAccounts = entry.client.subscribe('accounts.subscribe', null, (payload) => {
              if (!payload || typeof payload !== 'object') {
                return
              }
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
            fetchTaskProviders(entry.client, entry.hostId, setTaskProvidersByHost, () => false)
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
      for (const c of cleanups) {
        c()
      }
    }
    // Why: key on host-id set + each client's identity so resubs fire when forceReconnect swaps a host's client, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    allClients
      .map((e) => `${e.hostId}:${clientKey(e.client)}`)
      .sort()
      .join(',')
  ])

  // Why: prefer the worktree last opened on this device so Resume reflects mobile session history.
  // Why: don't gate on 'connected' so the card doesn't flash empty for ~1s on cold-start; cached data holds until fresh RPC lands.
  const resumeWorktree = useMemo(() => {
    // Why: only surface Resume for connected hosts; a stale worktree taps into a route that can't load.
    if (lastVisited && hostStates[lastVisited.hostId] === 'connected') {
      const cached = getCachedWorktrees(lastVisited.hostId) as WorktreeSummary[] | null
      const match = cached?.find((w) => w.worktreeId === lastVisited.worktreeId)
      if (match) {
        return { hostId: lastVisited.hostId, worktree: match }
      }
    }
    for (const host of sortedHosts) {
      if (hostStates[host.id] !== 'connected') {
        continue
      }
      const info = worktreeInfo[host.id]
      if (info?.lastActiveWorktree) {
        return { hostId: host.id, worktree: info.lastActiveWorktree }
      }
    }
    return null
  }, [sortedHosts, hostStates, worktreeInfo, lastVisited])

  // Why: only show Account usage for connected hosts; stale cached usage would imply live data.
  const accountsHosts = useMemo(() => {
    const items: Array<{ host: HostProfile; snapshot: AccountsSnapshot }> = []
    for (const host of sortedHosts) {
      if (hostStates[host.id] !== 'connected') {
        continue
      }
      const snap = accountsByHost[host.id]
      if (!snap) {
        continue
      }
      // Why: also show hosts whose only usage is the system-default login, else those users see no usage section.
      if (hasRenderableUsage(snap, 'claude') || hasRenderableUsage(snap, 'codex')) {
        items.push({ host, snapshot: snap })
      }
    }
    return items
  }, [sortedHosts, hostStates, accountsByHost])

  const primaryConnectedHost = useMemo(
    () => sortedHosts.find((host) => hostStates[host.id] === 'connected') ?? null,
    [sortedHosts, hostStates]
  )
  const primaryTaskProviders = primaryConnectedHost
    ? (taskProvidersByHost[primaryConnectedHost.id] ?? ['github'])
    : []
  const openTasks = useCallback(
    (provider?: TaskProvider) => {
      if (!primaryConnectedHost) {
        return
      }
      const suffix = provider ? `?taskSource=${provider}` : ''
      router.push(`/h/${primaryConnectedHost.id}/tasks${suffix}`)
    },
    [primaryConnectedHost, router]
  )
  const renderTaskHomeCard = () => (
    <Pressable
      disabled={!primaryConnectedHost}
      style={({ pressed }) => [
        styles.taskHomeCard,
        !primaryConnectedHost && styles.quickActionDisabled,
        pressed && styles.hostCardPressed
      ]}
      onPress={() => {
        openTasks()
      }}
    >
      <View style={styles.taskHomeIcon}>
        <ListTodo size={18} color={colors.textSecondary} />
      </View>
      <View style={styles.taskHomeMain}>
        <Text style={styles.taskHomeTitle}>Tasks</Text>
        <Text style={styles.taskHomeSubtitle} numberOfLines={1}>
          {primaryTaskProviders.length > 0
            ? primaryTaskProviders.map((provider) => TASK_PROVIDER_LABELS[provider]).join(' · ')
            : 'No task sources connected'}
        </Text>
      </View>
      <View style={styles.taskHomeTrailing}>
        <View
          style={styles.taskHomeProviderRow}
          accessibilityLabel={primaryTaskProviders
            .map((provider) => TASK_PROVIDER_LABELS[provider])
            .join(', ')}
        >
          {primaryTaskProviders.map((provider) => (
            <Pressable
              key={provider}
              accessibilityRole="button"
              accessibilityLabel={`Open ${TASK_PROVIDER_LABELS[provider]} tasks`}
              hitSlop={8}
              style={({ pressed }) => [
                styles.taskHomeProviderButton,
                pressed && styles.taskHomeProviderButtonPressed
              ]}
              onPress={(event) => {
                event.stopPropagation()
                openTasks(provider)
              }}
            >
              <TaskProviderLogo provider={provider} size={22} color={colors.textSecondary} />
            </Pressable>
          ))}
        </View>
      </View>
      <ChevronRight size={16} color={colors.textMuted} />
    </Pressable>
  )

  async function handleRemove() {
    if (!confirmRemove) {
      return
    }
    const hostToRemove = confirmRemove
    try {
      await removeHostAndCloseClient(hostToRemove.id, closeHostClient)
      setConfirmRemove(null)
      setHosts(await loadHosts())
    } catch {
      // Why: ConfirmModal closes on confirm; re-open for retry so the failure isn't silent.
      setConfirmRemove(hostToRemove)
      Alert.alert('Could not remove host', 'Please try again.')
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
        <View
          style={[
            styles.emptyContainer,
            { paddingBottom: insets.bottom },
            isWideLayout && { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' }
          ]}
        >
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
          // Why: reserve insets.bottom so the last row stays reachable above the system nav bar / home indicator.
          contentContainerStyle={[
            styles.list,
            { paddingBottom: spacing.xl + insets.bottom },
            isWideLayout && { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' }
          ]}
          ListHeaderComponent={
            <View>
              <View style={styles.hero}>
                <Text style={styles.heroTitle}>Welcome back</Text>
              </View>

              {stats && (
                <View style={styles.statsRow}>
                  <View style={styles.statCard}>
                    <Text style={styles.statValue}>
                      {stats.totalAgentsSpawned.toLocaleString()}
                    </Text>
                    <Text style={styles.statLabel}>Agents spawned</Text>
                  </View>
                  <View style={styles.statCard}>
                    <Text style={styles.statValue}>{formatDuration(stats.totalAgentTimeMs)}</Text>
                    <Text style={styles.statLabel}>Agent time</Text>
                  </View>
                  <View style={styles.statCard}>
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
            const info = worktreeInfo[item.id]
            const verdict = classifyConnection({
              state,
              reconnectAttempts: attempts,
              lastConnectedAt,
              endpoint: item.endpoint
            })
            return (
              <MobileHostCard
                host={item}
                state={state}
                verdict={verdict}
                path={hostPaths[item.id] ?? 'lan'}
                worktreeCounts={
                  info ? { total: info.totalWorktrees, active: info.activeCount } : undefined
                }
                onPress={() => router.push(`/h/${item.id}`)}
                onLongPress={() => {
                  triggerMediumImpact()
                  setActionTarget(item)
                }}
              />
            )
          }}
          ListFooterComponent={
            <View>
              {/* ─── Resume card ─── */}
              {resumeWorktree ? (
                <>
                  <Text style={[styles.sectionHeading, styles.sectionHeadingTightTop]}>Resume</Text>
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
                  <Text style={[styles.sectionHeading, styles.sectionHeadingTightTop]}>Tasks</Text>
                  {renderTaskHomeCard()}
                </>
              ) : (
                <>
                  <Text style={[styles.sectionHeading, styles.sectionHeadingTightTop]}>Tasks</Text>
                  {renderTaskHomeCard()}
                </>
              )}

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
                  disabled={!primaryConnectedHost}
                  style={({ pressed }) => [
                    styles.quickAction,
                    !primaryConnectedHost && styles.quickActionDisabled,
                    pressed && styles.hostCardPressed
                  ]}
                  onPress={() => {
                    if (primaryConnectedHost) {
                      router.push(`/h/${primaryConnectedHost.id}?action=newWorktree`)
                    }
                  }}
                >
                  <View style={styles.quickActionIcon}>
                    <Plus size={16} color={colors.textSecondary} />
                  </View>
                  <Text style={styles.quickActionLabel}>New Workspace</Text>
                </Pressable>
              </View>

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
                          const limits = getActiveProviderRateLimits(snapshot, provider)
                          // Why: with no managed accounts, still render the row when the active target has live usage data.
                          if (accounts.length === 0 && !hasActiveProviderUsage(limits)) {
                            return null
                          }
                          const sessionBar = getUsageBarState(limits, 'session')
                          const weeklyBar = getUsageBarState(limits, 'weekly')
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
                                    usedPercent={sessionBar.usedPercent}
                                    unavailable={sessionBar.unavailable}
                                    loading={sessionBar.loading}
                                  />
                                  <UsageBar
                                    label="7d"
                                    usedPercent={weeklyBar.usedPercent}
                                    unavailable={weeklyBar.unavailable}
                                    loading={weeklyBar.loading}
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
          if (!host) {
            return []
          }
          const state = hostStates[host.id] ?? 'connecting'
          const isLive =
            state === 'connected' ||
            state === 'connecting' ||
            state === 'handshaking' ||
            state === 'reconnecting'
          // Why: label "Connect" (not "Reconnect") when never connected this session, so the verb matches the action.
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
            label: 'Edit host',
            icon: Edit3,
            closeBeforePress: true,
            onPress: () => {
              setActionTarget(null)
              router.push(`/h/${host.id}/edit`)
            }
          })
          items.push({
            label: 'Remove',
            destructive: true,
            closeBeforePress: true,
            onPress: () => {
              setConfirmRemove(host)
            }
          })
          return items
        })()}
        onClose={() => setActionTarget(null)}
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
    paddingTop: spacing.xs,
    paddingBottom: spacing.md
  },
  heroTitle: {
    color: colors.textPrimary,
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: -0.3
  },

  /* ─── Stat cards ─── */
  statsRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: spacing.lg
  },
  statCard: {
    flex: 1,
    backgroundColor: 'rgba(26,26,26,0.6)',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: spacing.md
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
  sectionHeadingTightTop: {
    marginTop: spacing.lg
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
  hostCardPressed: {
    backgroundColor: colors.bgRaised
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
    paddingVertical: 12
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

  /* ─── Tasks card ─── */
  taskHomeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    minHeight: 72,
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    paddingVertical: 12
  },
  taskHomeIcon: {
    width: 46,
    height: 46,
    borderRadius: 13,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14
  },
  taskHomeMain: {
    flex: 1,
    minWidth: 0
  },
  taskHomeTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary
  },
  taskHomeSubtitle: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 3
  },
  taskHomeTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    marginLeft: spacing.sm
  },
  taskHomeProviderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2
  },
  taskHomeProviderButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button
  },
  taskHomeProviderButtonPressed: {
    backgroundColor: colors.bgRaised
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
  quickActionDisabled: {
    opacity: 0.45
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
