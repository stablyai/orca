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
  Plus
} from 'lucide-react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { loadHosts, removeHost, renameHost } from '../src/transport/host-store'
import { connect, type RpcClient } from '../src/transport/rpc-client'
import { subscribeToDesktopNotifications } from '../src/notifications/mobile-notifications'
import type { ConnectionState, HostProfile } from '../src/transport/types'
import { triggerMediumImpact } from '../src/platform/haptics'
import { OrcaLogo } from '../src/components/OrcaLogo'
import { TextInputModal } from '../src/components/TextInputModal'
import { ActionSheetModal } from '../src/components/ActionSheetModal'
import { ConfirmModal } from '../src/components/ConfirmModal'
import { setCachedWorktrees, getCachedWorktrees } from '../src/cache/worktree-cache'
import { colors, spacing, radii } from '../src/theme/mobile-theme'

function endpointLabel(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    return `${url.hostname}${url.port ? `:${url.port}` : ''}`
  } catch {
    return endpoint
  }
}

const STATUS_LABELS: Record<ConnectionState, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
  reconnecting: 'Reconnecting…',
  handshaking: 'Connecting…',
  'auth-failed': 'Auth failed'
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
  const markLoaded = () => {
    setInfo((prev) => ({
      ...prev,
      [hostId]: {
        hostId,
        totalWorktrees: 0,
        activeCount: 0,
        lastActiveWorktree: null
      }
    }))
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
        markLoaded()
      }
    })
    .catch(() => {
      if (!disposed()) markLoaded()
    })
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
  const [stats, setStats] = useState<StatsSummary | null>(null)
  const [worktreeInfo, setWorktreeInfo] = useState<Record<string, HostWorktreeInfo>>({})
  const [lastVisited, setLastVisited] = useState<{ hostId: string; worktreeId: string } | null>(
    null
  )
  const clientsRef = useRef<Array<{ hostId: string; client: RpcClient }>>([])

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
      for (const entry of clientsRef.current) {
        if (entry.client.getState() === 'connected') {
          fetchStats(entry.client, setStats, () => stale)
          fetchWorktreeInfo(entry.client, entry.hostId, setWorktreeInfo, () => stale)
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

  useEffect(() => {
    let disposed = false
    const notifCleanups: Array<() => void> = []
    const entries = hosts.flatMap((host) => {
      if (!host.publicKeyB64 || !host.deviceToken) {
        setHostStates((prev) => ({ ...prev, [host.id]: 'auth-failed' }))
        return []
      }
      setHostStates((prev) => ({
        ...prev,
        [host.id]: prev[host.id] ?? 'connecting'
      }))
      let client: ReturnType<typeof connect>
      try {
        client = connect(host.endpoint, host.deviceToken, host.publicKeyB64, (state) => {
          if (disposed) return
          setHostStates((prev) => ({ ...prev, [host.id]: state }))
        })
      } catch {
        setHostStates((prev) => ({ ...prev, [host.id]: 'auth-failed' }))
        return []
      }

      let unsubNotif: (() => void) | null = null
      let statsFetched = false
      const unsubState = client.onStateChange((state) => {
        if (state === 'connected') {
          if (!unsubNotif) {
            unsubNotif = subscribeToDesktopNotifications(client)
          }
          if (!statsFetched) {
            statsFetched = true
            fetchStats(client, setStats, () => disposed)
            fetchWorktreeInfo(client, host.id, setWorktreeInfo, () => disposed)
          }
        } else if (unsubNotif) {
          unsubNotif()
          unsubNotif = null
        }
      })
      notifCleanups.push(() => {
        unsubState()
        unsubNotif?.()
      })

      return [{ hostId: host.id, client }]
    })

    clientsRef.current = entries

    return () => {
      disposed = true
      clientsRef.current = []
      for (const cleanup of notifCleanups) cleanup()
      for (const entry of entries) entry.client.close()
    }
  }, [hosts])

  // Why: prefer the worktree the user last opened on this device so the
  // "Resume" card reflects their mobile session history, not just the
  // desktop's most-recently-outputting worktree.
  const resumeWorktree = useMemo(() => {
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

  const resumeLoading = useMemo(
    () =>
      sortedHosts.some((host) => {
        const state = hostStates[host.id] ?? 'connecting'
        return (
          state === 'connecting' ||
          state === 'handshaking' ||
          state === 'reconnecting' ||
          (state === 'connected' && !worktreeInfo[host.id])
        )
      }),
    [sortedHosts, hostStates, worktreeInfo]
  )

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
              Pair with Orca on your computer to monitor worktrees, watch agents work, and manage
              terminals — all from your phone.
            </Text>
            <Pressable style={styles.primaryButton} onPress={() => router.push('/pair-scan')}>
              <QrCode size={17} color={colors.bgBase} />
              <Text style={styles.primaryButtonText}>Scan Pairing Code</Text>
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
            const connected = state === 'connected'
            const info = worktreeInfo[item.id]
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
                    <View
                      style={[
                        styles.statusDot,
                        { backgroundColor: connected ? colors.statusGreen : colors.textMuted }
                      ]}
                    />
                    <Text style={styles.hostMetaItem}>
                      {STATUS_LABELS[state]}
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
              ) : hosts.length > 0 && resumeLoading ? (
                <>
                  <Text style={[styles.sectionHeading, { marginTop: spacing.xl }]}>Resume</Text>
                  <View style={styles.resumeCard}>
                    <View style={[styles.resumeIcon, styles.skeletonBlock]} />
                    <View style={styles.resumeMain}>
                      <View style={[styles.skeletonLine, { width: '55%' }]} />
                      <View style={[styles.skeletonLine, { width: '35%', marginTop: 6 }]} />
                    </View>
                  </View>
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
                    <QrCode size={20} color={colors.textSecondary} />
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
                    <Plus size={20} color={colors.textSecondary} />
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
        actions={[
          {
            label: 'Rename',
            onPress: () => {
              const host = actionTarget
              setActionTarget(null)
              if (host) setRenameTarget(host)
            }
          },
          {
            label: 'Remove',
            destructive: true,
            onPress: () => {
              const host = actionTarget
              setActionTarget(null)
              if (host) setConfirmRemove(host)
            }
          }
        ]}
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
    padding: spacing.md
  },
  statIcon: {
    width: 30,
    height: 30,
    borderRadius: 7,
    backgroundColor: 'rgba(255,255,255,0.04)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10
  },
  statValue: {
    color: colors.textPrimary,
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.3
  },
  statLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '500',
    marginTop: 3
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

  /* ─── Skeleton ─── */
  skeletonBlock: {
    backgroundColor: colors.bgRaised,
    opacity: 0.5
  },
  skeletonLine: {
    height: 12,
    borderRadius: 4,
    backgroundColor: colors.bgRaised,
    opacity: 0.5
  },

  /* ─── Quick actions ─── */
  quickActions: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  quickAction: {
    flex: 1,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    padding: spacing.lg,
    alignItems: 'center',
    gap: 10
  },
  quickActionIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.04)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  quickActionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary,
    textAlign: 'center'
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
