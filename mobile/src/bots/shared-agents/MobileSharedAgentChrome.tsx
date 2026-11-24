// The top of a shared agent's page and the line it shows while its owner's computer is away.
import { Pressable, Text, View } from 'react-native'
import { ChevronLeft, CloudOff, Lock } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { MobileStateView } from '../../components/feedback/MobileStateView'
import { mobileBotAvatarSource } from '../host-bot-row-facts'
import type { SharedAgentPage } from './use-shared-agent-page'
import { NavBar } from '../../components/nav-bar/NavBar'
import { NavBarButton } from '../../components/nav-bar/NavBarButton'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { MobileBotAvatar } from '../MobileBotAvatar'
import type { MobileBotAvatarSource } from '../host-bot-row-facts'

export function MobileSharedAgentNavBar({
  name,
  avatar,
  subtitle,
  onBack,
  labeledBack = false,
  trailing
}: {
  name: string
  avatar: MobileBotAvatarSource
  subtitle?: string
  onBack: () => void
  /** "‹ Bots", where Back returns to the list; a chat's Back is the bare chevron. */
  labeledBack?: boolean
  trailing?: React.ReactNode
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <NavBar
      leading={
        labeledBack ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('bots.shared.back', 'Back to bots')}
            hitSlop={8}
            onPress={onBack}
            style={styles.back}
          >
            <ChevronLeft size={24} color={colors.accentBlue} />
            <Text style={styles.backText}>{t('bots.shared.backLabel', 'Bots')}</Text>
          </Pressable>
        ) : (
          <NavBarButton
            icon={ChevronLeft}
            accessibilityLabel={t('bots.shared.back', 'Back to bots')}
            onPress={onBack}
          />
        )
      }
      trailing={trailing}
      center={
        <View style={styles.center}>
          <View style={styles.titleRow}>
            <MobileBotAvatar avatar={avatar} size={20} />
            <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
              {name}
            </Text>
          </View>
          {subtitle ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      }
    />
  )
}

/** Said wherever a message to the agent would wait for its owner's computer. */
export function MobileSharedAgentOfflineLine({ ownerName }: { ownerName: string }) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <View style={styles.offline}>
      <CloudOff size={15} color={colors.textMuted} />
      <Text style={styles.offlineText}>
        {t(
          'bots.shared.offline',
          '{{owner}}’s computer is offline. Messages wait and send when it’s back.',
          { owner: ownerName }
        )}
      </Text>
    </View>
  )
}

/** Before the phone has read its shared agents, and once this one is no longer shared with it. */
export function MobileSharedAgentUnavailable({
  page,
  onBack
}: {
  page: Exclude<SharedAgentPage, { kind: 'agent' }>
  onBack: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const insets = useSafeAreaInsets()
  const last = page.kind === 'removed' ? page.last : null
  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {last ? (
        <MobileSharedAgentNavBar
          name={last.botName}
          labeledBack
          avatar={mobileBotAvatarSource(
            page.kind === 'removed' && page.bot
              ? page.bot
              : { id: last.botId, name: last.botName, avatar: null }
          )}
          onBack={onBack}
        />
      ) : null}
      {page.kind === 'loading' ? (
        <MobileStateView loading title={t('common.loading', 'Loading…')} />
      ) : (
        <MobileStateView
          icon={Lock}
          title={
            last
              ? t('bots.shared.removedTitle', 'You no longer have access to {{name}}', {
                  name: last.botName
                })
              : t('bots.shared.removedTitleUnnamed', 'You no longer have access to this bot')
          }
          message={
            last
              ? t('bots.shared.removedBody', '{{owner}} stopped sharing it with you.', {
                  owner: last.ownerName
                })
              : undefined
          }
          action={{ label: t('bots.shared.backToBots', 'Back to bots'), onPress: onBack }}
        />
      )}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  center: { alignItems: 'center' },
  back: { flexDirection: 'row', alignItems: 'center', marginLeft: -spacing.xs },
  backText: { fontSize: 17, color: colors.accentBlue },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  title: { fontSize: 16, fontWeight: '600', color: colors.textPrimary },
  subtitle: { fontSize: typography.metaSize, color: colors.textSecondary },
  offline: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm
  },
  offlineText: { flex: 1, fontSize: typography.metaSize, color: colors.textSecondary }
}))
