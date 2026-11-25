import { Pressable, Text, View } from 'react-native'
import { CloudOff } from 'lucide-react-native'
import { colors } from '../../../../theme/mobile-theme'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { styles } from '../../mobile-native-chat-view-styles'
import type { MobileNativeChatInputLockReason } from '../../MobileNativeChatView'
import type { MobileNativeChatHostOutage } from '../../status/mobile-native-chat-host-outage'

/** The line above a locked composer: why it waits, or which host is out. */
export function MobileNativeChatInputLockStatus({
  lockReason,
  waitingText,
  hostOutage
}: {
  lockReason: MobileNativeChatInputLockReason | null
  waitingText: string
  hostOutage: MobileNativeChatHostOutage | null
}): React.JSX.Element {
  const t = useMobileTranslation()
  const outage =
    lockReason === 'disconnected' || lockReason === 'unreachable' || hostOutage?.holdsSends
      ? hostOutage
      : null
  const text = lockReason === 'waiting' ? waitingText : (outage?.text ?? null)
  // Why always mounted: the polite live region must exist before its text changes.
  return (
    <View style={text ? styles.inputLockStatusRow : undefined}>
      {text && outage?.holdsSends ? <CloudOff size={15} color={colors.textMuted} /> : null}
      <Text style={text ? styles.inputLockStatus : undefined} accessibilityLiveRegion="polite">
        {text}
      </Text>
      {outage?.onReconnect ? (
        <Pressable
          accessibilityRole="button"
          onPress={outage.onReconnect}
          style={({ pressed }) => [styles.retryPill, pressed && styles.retryPillPressed]}
        >
          <Text style={styles.retryPillLabel}>{t('common.offline.reconnect', 'Reconnect')}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}
