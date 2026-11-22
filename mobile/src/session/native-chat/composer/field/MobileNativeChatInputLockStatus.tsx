import { Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { styles } from '../../mobile-native-chat-view-styles'
import type { MobileNativeChatInputLockReason } from '../../MobileNativeChatView'
import type { MobileNativeChatHostOutage } from '../../status/mobile-native-chat-host-outage'
import type { MobileNativeChatAgentNotice } from '../../status/mobile-native-chat-agent-presence-copy'

/** The line above a locked composer: why it waits, which host is out, or what became of the agent. */
export function MobileNativeChatInputLockStatus({
  lockReason,
  waitingText,
  hostOutage,
  agentNotice = null
}: {
  lockReason: MobileNativeChatInputLockReason | null
  waitingText: string
  hostOutage: MobileNativeChatHostOutage | null
  agentNotice?: MobileNativeChatAgentNotice | null
}): React.JSX.Element {
  const t = useMobileTranslation()
  const outage = lockReason === 'disconnected' ? hostOutage : null
  // A waiting or offline composer explains itself first; the agent's line takes any other state.
  const notice = lockReason === 'waiting' || lockReason === 'disconnected' ? null : agentNotice
  const text = lockReason === 'waiting' ? waitingText : (outage?.text ?? notice?.text ?? null)
  const action = outage?.onReconnect
    ? { label: t('common.offline.reconnect', 'Reconnect'), onPress: outage.onReconnect }
    : (notice?.action ?? null)
  // Why always mounted: the polite live region must exist before its text changes.
  return (
    <View style={text ? styles.inputLockStatusRow : undefined}>
      <Text style={text ? styles.inputLockStatus : undefined} accessibilityLiveRegion="polite">
        {text}
      </Text>
      {action ? (
        <Pressable
          accessibilityRole="button"
          onPress={action.onPress}
          style={({ pressed }) => [styles.retryPill, pressed && styles.retryPillPressed]}
        >
          <Text style={styles.retryPillLabel}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}
