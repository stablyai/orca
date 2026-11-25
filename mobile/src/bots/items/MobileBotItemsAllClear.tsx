// The Items all-clear line, as the desktop's BotItemsAllClear: "Nothing needs you" with a check, muted,
// at a row's height so it reads as a state rather than a section header. The page header already shows
// the bot, so the line carries no picture.
import { Text, View } from 'react-native'
import { CircleCheck } from 'lucide-react-native'
import { LIST_ROW_PADDING } from '../../components/list/ListGroup'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { PhoneBot } from '../host-bots-operations'
import { colors, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

export function MobileBotItemsAllClear() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View style={styles.row}>
      <CircleCheck size={15} strokeWidth={2} color={colors.textMuted} />
      <Text style={styles.text}>{t('bots.items.empty.allClear', 'Nothing needs you')}</Text>
    </View>
  )
}

/** A group's: none while every member is paused, as on the desktop. */
export function MobileBotGroupItemsAllClear({ members }: { members: readonly PhoneBot[] }) {
  return members.every((bot) => bot.paused) ? null : <MobileBotItemsAllClear />
}

const styles = themedStyleSheet(() => ({
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: LIST_ROW_PADDING
  },
  text: { fontSize: typography.bodySize, color: colors.textMuted }
}))
