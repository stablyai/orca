import { Text, View } from 'react-native'
import { Gauge, Lightbulb } from 'lucide-react-native'
import type { BotRowStatus } from '../../../src/shared/bots/bot-row-status'
import type { WorktreeStatus } from '../../../src/shared/worktree/row-display/worktree-status-rollup'
import { AgentSpinner } from '../agents/presentation/AgentSpinner'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import type { MobileBotAvatarSource } from './host-bot-row-facts'
import { MobileBotItemStatusIcon } from './items/MobileBotItemStatusIcon'
import { MobileBotAvatar } from './MobileBotAvatar'

/** A bot's 32 pt picture with its status at the corner, or the amber gauge on a usage limit. */
export function MobileBotRowAvatar({
  avatar,
  dot,
  stopped = false,
  surface
}: {
  avatar: MobileBotAvatarSource
  dot: BotRowStatus | null
  stopped?: boolean
  surface?: string
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  return (
    <>
      <MobileBotAvatar avatar={avatar} size={32} />
      {stopped ? (
        <View style={[styles.status, surface ? { backgroundColor: surface } : null]}>
          <Gauge size={12} color={colors.statusAmber} />
        </View>
      ) : (
        <MobileBotRowStatus dot={dot} surface={surface} />
      )}
    </>
  )
}

/** A row picture's status at its corner, ringed in the surface it sits on; none draws nothing. */
export function MobileBotRowStatus({
  dot,
  surface
}: {
  dot: WorktreeStatus | null
  /** The row's background, when it isn't the page's (a grouped panel). */
  surface?: string
}) {
  const styles = useThemedStyles(stylesSheet)
  return dot && dot !== 'active' && dot !== 'done' ? (
    <View style={[styles.status, surface ? { backgroundColor: surface } : null]}>
      <AgentSpinner status={dot} />
    </View>
  ) : null
}

/** A bot's items that need you: an orange dot and the count, in the Up next count's muted style. */
export function MobileBotNeedsYouCount({ count }: { count: number }) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  return (
    <View
      style={styles.upNext}
      accessible
      accessibilityRole="image"
      accessibilityLabel={t('bots.items.needYouCount', '{{count}} items need you', {
        count,
        defaultValue_one: '{{count}} item needs you'
      })}
    >
      <MobileBotItemStatusIcon status="needs_you" size={6} />
      <Text style={styles.count}>{count}</Text>
    </View>
  )
}

/** A bot's new Up next suggestions, in the fold's muted count style, as the desktop's lightbulb. */
export function MobileBotUpNextCount({ count }: { count: number }) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  return (
    <View
      style={styles.upNext}
      accessible
      accessibilityRole="image"
      accessibilityLabel={t('bots.upNext.newInUpNext', '{{count}} new in Suggestions', { count })}
    >
      <Lightbulb size={12} color={colors.textMuted} />
      <Text style={styles.count}>{count}</Text>
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  status: {
    position: 'absolute',
    right: -5,
    bottom: -5,
    borderRadius: 12,
    backgroundColor: colors.bgBase,
    padding: 1
  },
  count: { fontSize: 13, color: colors.textMuted },
  upNext: { flexDirection: 'row', alignItems: 'center', gap: 2 }
}))
