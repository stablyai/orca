// The old bot, an arrow, then the new bot's picture or the bot an earlier import made. The desktop's ImportBotHero.
import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
import { ArrowRight } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import { botInitial } from '../../../src/shared/bots/bot-avatar-fallback'
import { mobileBotAvatarSource } from './host-bot-row-facts'
import type { ListedBot } from './host-bots-operations'
import { MobileBotAvatar } from './MobileBotAvatar'

export function MobileBotImportHero(props: {
  oldName: string | null | undefined
  oldLabel: string
  picture: ReactNode
  existing: ListedBot | null
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const { existing } = props
  return (
    <View style={styles.hero}>
      <View style={styles.side}>
        {props.oldName ? (
          <MobileBotAvatar avatar={{ kind: 'text', text: botInitial(props.oldName) }} size={56} />
        ) : (
          <View style={styles.oldTile}>
            <Text style={styles.unknown}>?</Text>
          </View>
        )}
        <Text style={styles.label} numberOfLines={1}>
          {props.oldLabel}
        </Text>
      </View>
      <ArrowRight size={20} color={colors.textMuted} />
      <View style={styles.side}>
        {existing ? (
          <MobileBotAvatar avatar={mobileBotAvatarSource(existing)} size={72} />
        ) : (
          props.picture
        )}
        <Text style={styles.label} numberOfLines={1}>
          {existing ? existing.name : t('bots.import.newBot', 'New bot')}
        </Text>
      </View>
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    paddingTop: spacing.sm
  },
  side: { alignItems: 'center', gap: spacing.xs, maxWidth: 120 },
  label: { fontSize: 12, color: colors.textSecondary },
  oldTile: {
    width: 56,
    height: 56,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.borderSubtle
  },
  unknown: { fontSize: 22, color: colors.textMuted }
}))
