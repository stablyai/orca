// The lines under the phone's Chats search: nothing matched, the search failed, or more matched than shown.
import { Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import {
  botChatMoreMatchesNote,
  type BotChatListView
} from '../../../src/shared/bots/bot-chat-tree-view'
import { MobileBotTextButton } from './MobileBotTextButton'

export function MobileBotChatSearchNotes({
  view,
  retry
}: {
  view: BotChatListView
  retry: (() => void) | undefined
}) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  return (
    <>
      {view.noMatch ? (
        <Text style={styles.note}>{t('bots.chats.noMatch', 'No chats or workers match.')}</Text>
      ) : null}
      {view.searchFailed && retry ? (
        <View style={styles.failed}>
          <Text style={styles.failedText}>
            {t('bots.chats.searchFailed', "Couldn't search this bot's chats.")}
          </Text>
          <MobileBotTextButton label={t('bots.chats.searchRetry', 'Try again')} onPress={retry} />
        </View>
      ) : null}
      {view.moreMatches > 0 ? (
        <Text style={styles.note}>{botChatMoreMatchesNote(t, view.moreMatches)}</Text>
      ) : null}
    </>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  note: {
    fontSize: 12,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm
  },
  failed: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm
  },
  failedText: { fontSize: 12, color: colors.textMuted }
}))
