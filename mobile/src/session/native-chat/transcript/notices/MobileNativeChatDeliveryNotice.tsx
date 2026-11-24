// A held message's word: a quiet pill while it waits, or Not sent with Send again.
import { useContext, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { CircleAlert, Clock } from 'lucide-react-native'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import {
  MobileNativeChatDeliveryContext,
  type MobileNativeChatDeliveryNotice as Notice
} from './mobile-native-chat-delivery'

/** The word under a sent message the chat's view holds one for (`MobileNativeChatDeliveryContext`). */
export function MobileNativeChatMessageDelivery({ messageId }: { messageId: string }) {
  const notice = useContext(MobileNativeChatDeliveryContext)?.notices.get(messageId)
  return notice ? (
    <View style={styles.under}>
      <MobileNativeChatDeliveryNotice notice={notice} />
    </View>
  ) : null
}

export function MobileNativeChatDeliveryNotice({ notice }: { notice: Notice }) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const [sending, setSending] = useState(false)
  const { onSendAgain } = notice
  return (
    <View style={styles.row}>
      <View style={styles.pill}>
        {notice.waiting ? (
          <Clock size={13} color={colors.textMuted} />
        ) : (
          <CircleAlert size={13} color={colors.statusRed} />
        )}
        <Text style={styles.text}>{notice.text}</Text>
      </View>
      {onSendAgain ? (
        <Pressable
          accessibilityRole="button"
          disabled={sending}
          hitSlop={8}
          onPress={() => {
            setSending(true)
            void onSendAgain().finally(() => setSending(false))
          }}
        >
          <Text style={styles.action}>{t('chat.sharedHeld.sendAgain', 'Send again')}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  under: { marginTop: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.bgRaised,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2
  },
  text: { fontSize: typography.metaSize, color: colors.textSecondary },
  action: { fontSize: typography.metaSize, color: colors.accentBlue }
}))
