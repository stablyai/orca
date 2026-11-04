import { Gauge, RefreshCw } from 'lucide-react-native'
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withTiming
} from 'react-native-reanimated'
import {
  getUsageBarState,
  getWindowResetLabel,
  usageBarFill,
  type AccountsSnapshot,
  type ProviderKey
} from '../../components/AccountUsage'
import { ClaudeIcon, OpenAIIcon } from '../../components/AgentIcons'
import { useNow } from '../../hooks/use-now'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useResponsiveLayout } from '../../layout/responsive-layout'
import { useReducedMotionEnabled } from '../../platform/use-reduced-motion'
import type { HomeStatsSummary } from '../../stats/home-stats-total'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useHostClient } from '../../transport/host-client-hooks'
import type { ConnectionState, HostProfile } from '../../transport/types'
import { useHostDisplay } from '../../transport/use-host-display'
import { formatTimeAgo } from '../../worktree/agent-row-display'
import { homeListStyles } from '../home-list-styles'
import { MobileHomeSectionHeading } from '../MobileHomeSectionHeading'
import { MobileHomeStats } from '../MobileHomeStats'
import { HOME_EASE_OUT } from './home-tabs'
import { selectHomeUsageSections, type HomeUsageCard } from './home-usage-cards'
import { MobileHomeHostPill, useHomeTabHost } from './MobileHomeHostPill'
import { MobileHomeTabHeader, MobileHomeTabHeaderButton } from './MobileHomeTabHeader'

const PROVIDER_TITLES: Record<ProviderKey, string> = { claude: 'Claude Code', codex: 'Codex' }

/** Usage: agent account quota on one desktop, after the totals across all of them. */
export function MobileHomeUsageTab(props: {
  hosts: readonly HostProfile[]
  connectedHosts: readonly HostProfile[]
  hostStates: Record<string, ConnectionState>
  accountsByHost: Record<string, AccountsSnapshot>
  stats: HomeStatsSummary | null
  bottomInset: number
  onOpenAccounts: (hostId: string) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { isWideLayout, contentMaxWidth } = useResponsiveLayout()
  const { host, pick } = useHomeTabHost(props.hosts, props.connectedHosts)
  const { client } = useHostClient(host?.id)
  const connected = host != null && props.hostStates[host.id] === 'connected'
  const [refreshingHostId, setRefreshingHostId] = useState<string | null>(null)
  const refreshing = host != null && refreshingHostId === host.id

  // Why: the host pushes the refreshed usage over accounts.subscribe too, so the reply goes unread.
  const refresh = useCallback(async () => {
    if (!client || !host || refreshing) {
      return
    }
    setRefreshingHostId(host.id)
    try {
      await client.sendRequest('accounts.list', { refreshUsage: true })
    } catch {
      // A failed refresh leaves the streamed usage on screen.
    } finally {
      setRefreshingHostId((current) => (current === host.id ? null : current))
    }
  }, [client, host, refreshing])

  return (
    <View style={styles.screen}>
      <MobileHomeTabHeader
        title={t('home.tabs.usage', 'Usage')}
        trailing={
          host ? (
            <MobileHomeTabHeaderButton
              icon={RefreshCw}
              spinning={refreshing}
              disabled={!connected || !client}
              accessibilityLabel={t('home.usage.refresh', 'Refresh usage')}
              onPress={() => void refresh()}
            />
          ) : undefined
        }
      />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: spacing.xl + props.bottomInset },
          isWideLayout && { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' }
        ]}
      >
        {host ? (
          <MobileHomeHostPill
            hosts={props.hosts}
            host={host}
            state={props.hostStates[host.id]}
            pickerTitle={t('home.usage.showUsageFor', 'Show usage for')}
            onPick={pick}
          />
        ) : null}
        {props.stats ? <MobileHomeStats stats={props.stats} first /> : null}
        {host ? (
          <HostUsage
            host={host}
            connected={connected}
            snapshot={props.accountsByHost[host.id] ?? null}
            first={!props.stats}
            onOpenAccounts={props.onOpenAccounts}
          />
        ) : (
          <UsageEmpty
            message={t('home.usage.pairDesktop', 'Pair a desktop to see agent account usage.')}
          />
        )}
      </ScrollView>
    </View>
  )
}

function HostUsage(props: {
  host: HostProfile
  connected: boolean
  snapshot: AccountsSnapshot | null
  first: boolean
  onOpenAccounts: (hostId: string) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const reducedMotion = useReducedMotionEnabled() === true
  const desktop = useHostDisplay(props.host).title
  // Why: the reset countdowns and "Updated" note only flip on minute boundaries.
  const now = useNow(60_000, props.connected)
  // The tab's first desktop appears in place; only a switch to another one fades in.
  const [initialHostId] = useState(props.host.id)

  if (!props.connected) {
    return (
      <UsageEmpty
        message={t('home.usage.connectDesktop', 'Connect {{desktop}} to see agent account usage.', {
          desktop
        })}
      />
    )
  }
  if (!props.snapshot) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="small" color={colors.textSecondary} />
      </View>
    )
  }
  const sections = selectHomeUsageSections(props.snapshot)
  if (sections.length === 0) {
    return (
      <UsageEmpty
        message={t('home.usage.addAccounts', 'Add accounts from desktop Settings → Accounts.')}
      />
    )
  }
  return (
    <Animated.View
      key={props.host.id}
      entering={reducedMotion || props.host.id === initialHostId ? undefined : FadeIn.duration(180)}
    >
      {sections.map((section, index) => (
        <View key={section.provider}>
          <MobileHomeSectionHeading
            title={PROVIDER_TITLES[section.provider]}
            first={props.first && index === 0}
            aside={
              section.updatedAt == null
                ? undefined
                : now - section.updatedAt < 60_000
                  ? t('home.usage.updatedJustNow', 'Updated just now')
                  : t('home.usage.updatedAgo', 'Updated {{time}} ago', {
                      time: formatTimeAgo(section.updatedAt, now)
                    })
            }
          />
          <View style={homeListStyles.group}>
            {section.cards.map((card, cardIndex) => (
              <UsageCard
                key={card.accountId ?? 'default'}
                provider={section.provider}
                card={card}
                separated={cardIndex > 0}
                now={now}
                reducedMotion={reducedMotion}
                onPress={() => props.onOpenAccounts(props.host.id)}
              />
            ))}
          </View>
        </View>
      ))}
    </Animated.View>
  )
}

function UsageCard(props: {
  provider: ProviderKey
  card: HomeUsageCard
  separated: boolean
  now: number
  reducedMotion: boolean
  onPress: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const [pressed, setPressed] = useState(false)
  const { card } = props
  const title = card.email ?? t('accounts.screen.default', 'System default')
  const subtitle =
    card.email == null
      ? t('accounts.screen.agentLogin', "Use the agent's own login")
      : card.subtitle
  const windows: { key: 'session' | 'weekly'; label: string }[] = [
    { key: 'session', label: t('accounts.screen.sessionWindow', '5h') },
    { key: 'weekly', label: t('accounts.screen.weeklyWindow', '7d') }
  ]
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[title, subtitle, card.active ? t('home.usage.active', 'Active') : null]
        .filter(Boolean)
        .join(', ')}
      accessibilityHint={t('home.usage.openAccountsHint', 'Opens this desktop’s accounts')}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onPress={props.onPress}
    >
      <Animated.View
        style={[
          styles.card,
          props.separated && styles.cardSeparated,
          pressed && styles.cardPressed,
          {
            transform: [{ scale: pressed && !props.reducedMotion ? 0.98 : 1 }],
            transitionProperty: ['transform', 'backgroundColor'],
            transitionDuration: 120
          }
        ]}
      >
        <View style={styles.head}>
          <View style={styles.tile}>
            {props.provider === 'claude' ? (
              <ClaudeIcon size={16} />
            ) : (
              <OpenAIIcon size={16} color={colors.textPrimary} />
            )}
          </View>
          <View style={styles.headText}>
            <Text style={styles.cardTitle} numberOfLines={1}>
              {title}
            </Text>
            {subtitle ? (
              <Text style={styles.cardSubtitle} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          {card.active ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{t('home.usage.active', 'Active')}</Text>
            </View>
          ) : null}
        </View>
        {card.metered
          ? windows.map((window) => (
              <UsageMeter
                key={window.key}
                label={window.label}
                card={card}
                windowKey={window.key}
                now={props.now}
                reducedMotion={props.reducedMotion}
              />
            ))
          : null}
      </Animated.View>
    </Pressable>
  )
}

function UsageMeter(props: {
  label: string
  card: HomeUsageCard
  windowKey: 'session' | 'weekly'
  now: number
  reducedMotion: boolean
}) {
  useMobileColorScheme()
  const bar = getUsageBarState(props.card.limits, props.windowKey, props.card.fetching)
  const { used, color } = usageBarFill(bar.usedPercent, bar.unavailable)
  const reset = getWindowResetLabel(props.card.limits, props.windowKey, props.now)
  const target = used ?? 0
  const width = useSharedValue(props.reducedMotion ? target : 0)

  useEffect(() => {
    width.value = props.reducedMotion
      ? target
      : withTiming(target, { duration: 450, easing: HOME_EASE_OUT })
  }, [props.reducedMotion, target, width])

  const fillStyle = useAnimatedStyle(() => ({ width: `${width.value}%` }))
  const value = bar.unavailable || used == null ? '—' : `${used}%`

  return (
    <>
      <View
        style={styles.meter}
        accessible
        accessibilityLabel={[props.label, value, reset].filter(Boolean).join(', ')}
      >
        <Text style={styles.meterLabel}>{props.label}</Text>
        <View style={styles.track}>
          <Animated.View style={[styles.fill, { backgroundColor: color }, fillStyle]} />
        </View>
        {bar.loading ? (
          <ActivityIndicator size="small" color={colors.textSecondary} style={styles.meterValue} />
        ) : (
          <Text style={styles.meterValue}>{value}</Text>
        )}
      </View>
      {reset ? (
        <Text style={styles.reset} numberOfLines={1}>
          {reset}
        </Text>
      ) : null}
    </>
  )
}

function UsageEmpty(props: { message: string }) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <View style={styles.empty}>
      <Gauge size={28} color={colors.textMuted} />
      <Text style={styles.emptyTitle} accessibilityRole="header">
        {t('home.usage.emptyTitle', 'No usage yet')}
      </Text>
      <Text style={styles.emptyBody}>{props.message}</Text>
    </View>
  )
}

const TILE_SIZE = 28
const METER_LABEL_WIDTH = 26
const METER_GAP = 10

const styles = themedStyleSheet(() => ({
  screen: { flex: 1 },
  content: { paddingHorizontal: spacing.lg },
  loading: { alignItems: 'center', paddingVertical: 60 },
  card: { paddingVertical: 14, paddingHorizontal: spacing.lg, backgroundColor: colors.bgPanel },
  cardSeparated: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle },
  cardPressed: { backgroundColor: colors.bgRaised },
  head: { flexDirection: 'row', alignItems: 'center', gap: METER_GAP, marginBottom: 4 },
  tile: {
    width: TILE_SIZE,
    height: TILE_SIZE,
    borderRadius: radii.tile,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  headText: { flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 16, lineHeight: 22, color: colors.textPrimary },
  cardSubtitle: { fontSize: 13, lineHeight: 17, color: colors.textSecondary, marginTop: 1 },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.pill,
    backgroundColor: colors.skillTokenSurface
  },
  badgeText: { fontSize: 12, color: colors.accentBlue },
  meter: { flexDirection: 'row', alignItems: 'center', gap: METER_GAP, marginTop: 6 },
  meterLabel: { width: METER_LABEL_WIDTH, fontSize: 13, color: colors.textSecondary },
  track: {
    flex: 1,
    height: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.translucentFill,
    overflow: 'hidden'
  },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: radii.pill },
  meterValue: {
    width: 40,
    fontSize: 13,
    color: colors.textPrimary,
    textAlign: 'right',
    fontVariant: ['tabular-nums']
  },
  reset: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
    marginLeft: METER_LABEL_WIDTH + METER_GAP
  },
  empty: {
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: 28,
    marginTop: 32
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.textPrimary,
    marginTop: spacing.sm,
    marginBottom: spacing.xs
  },
  emptyBody: { fontSize: 15, lineHeight: 20, color: colors.textSecondary, textAlign: 'center' }
}))
