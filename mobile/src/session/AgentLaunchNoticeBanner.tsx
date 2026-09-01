import { View, Text, Pressable, StyleSheet } from 'react-native'
import { TriangleAlert, X } from 'lucide-react-native'
import { colors, spacing, radii, typography } from '../theme/mobile-theme'
import type {
  AgentLaunchNotice,
  AgentLaunchNoticeCode
} from '../../../src/shared/agent-launch-contract'
import { mobileLaunchNoticeTier, resolveMobileLaunchNoticeText } from './mobile-launch-notice-copy'

type Props = {
  notices: readonly AgentLaunchNotice[]
  onDismiss: (code: AgentLaunchNoticeCode) => void
}

/** Presentational mobile launch-notice banner. The host owns notice state and
 *  dismissal; this component only renders the host-supplied typed notices and
 *  reports a per-code dismissal back through `onDismiss`. Kept free of RPC/store
 *  so the copy stays deterministic and the store wiring lands with the U7 flip. */
export function AgentLaunchNoticeBanner({ notices, onDismiss }: Props) {
  if (notices.length === 0) {
    return null
  }
  const bannerNotices = notices.filter((notice) => mobileLaunchNoticeTier(notice) === 'banner')
  const chipNotices = notices.filter((notice) => mobileLaunchNoticeTier(notice) === 'chip')
  return (
    <View style={styles.container}>
      {bannerNotices.map((notice) => (
        <View key={notice.code} accessibilityRole="alert" style={styles.bannerRow}>
          <TriangleAlert size={16} color={colors.statusAmber} />
          <Text style={styles.bannerText}>{resolveMobileLaunchNoticeText(notice)}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            hitSlop={8}
            onPress={() => onDismiss(notice.code)}
          >
            <X size={16} color={colors.textMuted} />
          </Pressable>
        </View>
      ))}
      {chipNotices.map((notice) => (
        <View key={notice.code} accessibilityRole="text" style={styles.chipRow}>
          <Text style={styles.chipText} numberOfLines={2}>
            {resolveMobileLaunchNoticeText(notice)}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            hitSlop={8}
            onPress={() => onDismiss(notice.code)}
          >
            <X size={14} color={colors.textMuted} />
          </Pressable>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised
  },
  bannerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  bannerText: {
    flex: 1,
    fontSize: typography.bodySize,
    lineHeight: 18,
    color: colors.textPrimary
  },
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.input
  },
  chipText: {
    flex: 1,
    fontSize: 12,
    color: colors.textSecondary
  }
})
