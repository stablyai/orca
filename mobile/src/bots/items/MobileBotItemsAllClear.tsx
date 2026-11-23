// The Items all-clear line, as the desktop's BotItemsAllClear: the bot's picture, greyed, over
// "Nothing needs you", leading the folded groups.
import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { mobileBotAvatarSource } from '../host-bot-row-facts'
import type { PhoneBot } from '../host-bots-operations'
import { MobileBotFaceStack } from '../MobileBotFaceStack'
import { colors, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

/** `picture`: 40 pt, greyed here. */
export function MobileBotItemsAllClear({ picture }: { picture: ReactNode }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View style={styles.root}>
      <View
        style={styles.picture}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {picture}
      </View>
      <Text style={styles.text} numberOfLines={1}>
        {t('bots.items.empty.allClear', 'Nothing needs you')}
      </Text>
    </View>
  )
}

/** A group's: its members' faces; none while every member is paused, as on the desktop. */
export function MobileBotGroupItemsAllClear({ members }: { members: readonly PhoneBot[] }) {
  if (members.every((bot) => bot.paused)) {
    return null
  }
  return (
    <MobileBotItemsAllClear
      picture={
        <MobileBotFaceStack
          slot={40}
          ringColor={colors.sheetSurface}
          faces={members.map((bot) => ({ id: bot.id, avatar: mobileBotAvatarSource(bot) }))}
        />
      }
    />
  )
}

const styles = themedStyleSheet(() => ({
  root: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.md },
  picture: { opacity: 0.5, filter: 'grayscale(1)' },
  text: { fontSize: typography.metaSize, color: colors.textMuted }
}))
