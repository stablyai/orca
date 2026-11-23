// The line under an item's title: which item and chat, then when it was made in chat's time words
// ("2:56 PM", "Yesterday 2:56 PM", "Nov 14, 2:56 PM"). The chat name gives way first.
import { Text, View } from 'react-native'
import type { BotItem } from '../../../../src/shared/bots/bot-items'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMobileMessageTime } from '../../session/native-chat/transcript/messages/use-mobile-message-time'
import { colors, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

export function MobileBotItemSubtitle({ item, chatTitle }: { item: BotItem; chatTitle: string }) {
  const t = useMobileTranslation()
  const time = useMobileMessageTime()
  const made = time.label(item.createdAt)
  return (
    <View style={styles.row}>
      <Text style={[styles.sub, styles.where]} numberOfLines={1}>
        {t('bots.items.view.subWhere', 'Item {{number}} · {{chat}}', {
          number: item.number,
          chat: chatTitle
        })}
      </Text>
      {made ? (
        <Text style={styles.sub} accessibilityLabel={time.full(item.createdAt)}>
          {` · ${made}`}
        </Text>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  row: { flexDirection: 'row' },
  where: { flexShrink: 1 },
  sub: { fontSize: typography.metaSize, color: colors.textMuted }
}))
