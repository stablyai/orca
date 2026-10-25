import { useEffect, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useGlobalSearchParams, usePathname, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { hostStackRouteHref } from '../navigation/host-stack-navigation'
import { firstParam } from '../navigation/route-param-reader'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { dismissConsumedTrayNotifications } from './consumed-notification-tray-dismissal'
import {
  dismissInAppNotificationBanner,
  getCurrentInAppNotificationBanner,
  subscribeInAppNotificationBanner
} from './in-app-notification-banner-store'
import { dispatchInPageNotificationNavigation } from './in-page-notification-navigation'
import { getNotificationNavigationTarget } from './notification-routing'
import { isViewingWorkspaceTarget } from './notification-viewing-policy'
import { useOpenNotificationRoute } from './use-open-notification-route'

const AUTO_DISMISS_MS = 12000

function normalizeParam(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function paramMatches(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) {
    return false
  }
  return actual === expected || normalizeParam(actual) === normalizeParam(expected)
}

export function InAppNotificationBanner() {
  const banner = useSyncExternalStore(
    subscribeInAppNotificationBanner,
    getCurrentInAppNotificationBanner,
    getCurrentInAppNotificationBanner
  )
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const pathname = usePathname()
  const activeParams = useGlobalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
  }>()
  const openNotificationRoute = useOpenNotificationRoute()
  const bannerId = banner?.id
  const bannerCreatedAt = banner?.createdAt

  useEffect(() => {
    if (!bannerId) {
      return
    }
    const timer = setTimeout(() => {
      dismissInAppNotificationBanner(bannerId)
    }, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [bannerId, bannerCreatedAt])

  if (!banner) {
    return null
  }

  const isUrgent = banner.tone === 'urgent'
  const isTerminalBell = banner.title.startsWith('Bell in ')
  const accentColor = isUrgent ? colors.statusAmber : colors.statusGreen
  const badgeIcon = isUrgent ? '⚡' : isTerminalBell ? '🔔' : '✅'
  const badgeLabel = isUrgent ? 'Needs input' : isTerminalBell ? 'Terminal bell' : 'Completed'
  const canNavigate = Boolean(banner.hostId)
  const promptText = banner.prompt?.trim() ?? ''
  const hasPrompt = promptText.length > 0
  const accessibilitySummary = [
    `${badgeLabel}: ${banner.title}`,
    hasPrompt ? promptText : undefined,
    banner.body.length > 0 ? banner.body : undefined
  ]
    .filter((part): part is string => Boolean(part))
    .join('. ')

  const handlePress = () => {
    dismissInAppNotificationBanner(banner.id)
    void dismissConsumedTrayNotifications(banner)
    if (!canNavigate || !banner.hostId) {
      return
    }
    const activeHostId = firstParam(activeParams.hostId)
    const activeWorktreeId = firstParam(activeParams.worktreeId)
    const onSameHost = pathname.startsWith('/h/') && paramMatches(activeHostId, banner.hostId)
    if (
      onSameHost &&
      banner.worktreeId &&
      dispatchInPageNotificationNavigation({
        hostId: banner.hostId,
        worktreeId: banner.worktreeId,
        paneKey: banner.paneKey,
        executionHost: banner.executionHost
      })
    ) {
      return
    }
    const onNativeSessionRoute =
      Boolean(banner.worktreeId) &&
      onSameHost &&
      pathname.includes('/session/') &&
      paramMatches(activeWorktreeId, banner.worktreeId)
    const onSameWorkspace =
      Boolean(banner.worktreeId) &&
      (onNativeSessionRoute ||
        isViewingWorkspaceTarget({
          hostId: banner.hostId,
          worktreeId: banner.worktreeId,
          executionHost: banner.executionHost
        }))
    const target = getNotificationNavigationTarget({
      hostId: banner.hostId,
      worktreeId: banner.worktreeId,
      paneKey: banner.paneKey,
      executionHost: banner.executionHost
    })
    if (onSameWorkspace) {
      if (banner.paneKey && target) {
        if (onNativeSessionRoute) {
          openNotificationRoute(target)
        } else if (onSameHost && target.sessionTarget) {
          router.replace(hostStackRouteHref(target.sessionTarget))
        }
      }
      return
    }
    if (!target) {
      return
    }
    if (onSameHost && target.sessionTarget) {
      router.replace(hostStackRouteHref(target.sessionTarget))
      return
    }
    if (onSameHost && !target.sessionTarget && !pathname.includes('/session/')) {
      return
    }
    openNotificationRoute(target)
  }

  const handleDismiss = () => {
    dismissInAppNotificationBanner(banner.id)
    void dismissConsumedTrayNotifications(banner)
  }

  return (
    <View
      accessibilityRole={isUrgent ? 'alert' : undefined}
      accessibilityLiveRegion={isUrgent ? 'assertive' : 'polite'}
      pointerEvents="box-none"
      style={[styles.overlay, { top: Math.max(insets.top, spacing.sm) + spacing.xs }]}
    >
      <View style={styles.capsule}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilitySummary}
          onPress={handlePress}
          style={({ pressed }) => [styles.mainPressable, pressed && styles.capsulePressed]}
        >
          <View style={[styles.indicatorBar, { backgroundColor: accentColor }]} />
          <View style={styles.content}>
            <View style={styles.headerRow}>
              <Text style={[styles.badgeIcon, { color: accentColor }]}>{badgeIcon}</Text>
              <Text numberOfLines={1} ellipsizeMode="tail" style={styles.title}>
                {banner.title}
              </Text>
            </View>
            {hasPrompt ? (
              <Text numberOfLines={1} ellipsizeMode="tail" style={styles.promptLine}>
                {promptText}
              </Text>
            ) : null}
            {banner.body.length > 0 ? (
              <Text numberOfLines={hasPrompt ? 1 : 2} ellipsizeMode="tail" style={styles.body}>
                {banner.body}
              </Text>
            ) : null}
          </View>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss notification banner"
          hitSlop={8}
          onPress={handleDismiss}
          style={styles.closeButton}
        >
          <Text style={styles.closeText}>✕</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    zIndex: 9999,
    elevation: 24
  },
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    paddingVertical: spacing.sm + 2,
    paddingLeft: spacing.md,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
    elevation: 14
  },
  mainPressable: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center'
  },
  capsulePressed: {
    opacity: 0.92
  },
  indicatorBar: {
    width: 3.5,
    alignSelf: 'stretch',
    borderRadius: 2,
    marginVertical: 2
  },
  content: {
    flex: 1,
    paddingLeft: spacing.sm + 2,
    paddingRight: spacing.xs,
    gap: 3
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 1
  },
  badgeIcon: {
    fontSize: 12,
    lineHeight: 16
  },
  title: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  promptLine: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    lineHeight: 17
  },
  body: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    lineHeight: 17
  },
  closeButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    alignSelf: 'flex-start'
  },
  closeText: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontWeight: '600'
  }
})
