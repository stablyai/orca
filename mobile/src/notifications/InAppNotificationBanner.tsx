import { useEffect, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import * as Notifications from 'expo-notifications'
import { useGlobalSearchParams, usePathname, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { hostStackRouteHref } from '../navigation/host-stack-navigation'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import {
  dismissInAppNotificationBanner,
  getCurrentInAppNotificationBanner,
  subscribeInAppNotificationBanner
} from './in-app-notification-banner-store'
import { getNotificationNavigationTarget } from './notification-routing'
import { useOpenNotificationRoute } from './use-open-notification-route'

const AUTO_DISMISS_MS = 12000

function paramMatches(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) {
    return false
  }
  if (actual === expected) {
    return true
  }
  try {
    return decodeURIComponent(actual) === expected
  } catch {
    return false
  }
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
    hostId?: string
    worktreeId?: string
  }>()
  const openNotificationRoute = useOpenNotificationRoute()
  const bannerId = banner?.id

  useEffect(() => {
    if (!bannerId) {
      return
    }
    const timer = setTimeout(() => {
      dismissInAppNotificationBanner(bannerId)
    }, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [bannerId])

  if (!banner) {
    return null
  }

  const isUrgent = banner.tone === 'urgent'
  const accentColor = isUrgent ? colors.statusAmber : colors.statusGreen
  const badgeText = isUrgent ? '⚡ Needs input' : '✅ Completed'
  const canNavigate =
    typeof banner.hostId === 'string' &&
    banner.hostId.length > 0 &&
    typeof banner.worktreeId === 'string' &&
    banner.worktreeId.length > 0

  const handlePress = () => {
    dismissInAppNotificationBanner(banner.id)
    if (banner.osNotificationIdentifier) {
      void Notifications.dismissNotificationAsync(banner.osNotificationIdentifier).catch(() => {})
    }
    if (!canNavigate) {
      return
    }
    const onSameHost =
      pathname.startsWith('/h/') && paramMatches(activeParams.hostId, banner.hostId)
    const onSameWorkspace =
      onSameHost &&
      pathname.includes('/session/') &&
      paramMatches(activeParams.worktreeId, banner.worktreeId)
    if (onSameWorkspace) {
      if (banner.paneKey) {
        router.setParams({ paneKey: banner.paneKey })
      }
      return
    }
    const target = getNotificationNavigationTarget({
      hostId: banner.hostId,
      worktreeId: banner.worktreeId,
      paneKey: banner.paneKey,
      executionHost: banner.executionHost
    })
    if (!target) {
      return
    }
    if (onSameHost && target.sessionTarget) {
      router.replace(hostStackRouteHref(target.sessionTarget))
      return
    }
    openNotificationRoute(target)
  }

  const handleDismiss = () => {
    dismissInAppNotificationBanner(banner.id)
  }

  return (
    <View
      pointerEvents="box-none"
      style={[styles.overlay, { top: Math.max(insets.top, spacing.sm) + spacing.xs }]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${badgeText}: ${banner.title}. ${banner.body}`}
        onPress={handlePress}
        style={({ pressed }) => [styles.capsule, pressed && styles.capsulePressed]}
      >
        <View style={[styles.indicatorBar, { backgroundColor: accentColor }]} />
        <View style={styles.content}>
          <View style={styles.headerRow}>
            <View style={[styles.badge, isUrgent ? styles.badgeUrgent : styles.badgeComplete]}>
              <Text style={[styles.badgeText, { color: accentColor }]}>{badgeText}</Text>
            </View>
            <Text numberOfLines={1} style={styles.hostName}>
              {banner.hostName}
            </Text>
            {canNavigate ? <Text style={styles.jumpHint}>Jump →</Text> : null}
          </View>
          <Text numberOfLines={1} style={styles.title}>
            {banner.title}
          </Text>
          {banner.body.length > 0 ? (
            <Text numberOfLines={2} style={styles.body}>
              {banner.body}
            </Text>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss notification banner"
          hitSlop={8}
          onPress={handleDismiss}
          style={styles.closeButton}
        >
          <Text style={styles.closeText}>✕</Text>
        </Pressable>
      </Pressable>
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
    gap: spacing.sm
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.row
  },
  badgeUrgent: {
    backgroundColor: 'rgba(245, 158, 11, 0.16)'
  },
  badgeComplete: {
    backgroundColor: 'rgba(34, 197, 94, 0.16)'
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700'
  },
  hostName: {
    flex: 1,
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  jumpHint: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '600'
  },
  title: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700'
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
