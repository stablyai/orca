// The Items all-clear line, as the desktop's BotItemsAllClear: "Nothing needs you" in muted text on
// the rows' edge. The page header already shows the bot, so the line carries no picture.
import { Text } from 'react-native'
import { LIST_ROW_PADDING } from '../../components/list/ListGroup'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { PhoneBot } from '../host-bots-operations'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

export function MobileBotItemsAllClear() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return <Text style={styles.text}>{t('bots.items.empty.allClear', 'Nothing needs you')}</Text>
}

/** A group's: none while every member is paused, as on the desktop. */
export function MobileBotGroupItemsAllClear({ members }: { members: readonly PhoneBot[] }) {
  return members.every((bot) => bot.paused) ? null : <MobileBotItemsAllClear />
}

const styles = themedStyleSheet(() => ({
  text: {
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: spacing.xs,
    fontSize: 13,
    lineHeight: 20,
    color: colors.textMuted
  }
}))
