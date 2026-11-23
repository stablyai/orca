import { createContext, useContext } from 'react'
import { Pressable, Text, View } from 'react-native'
import { CornerDownRight, Pencil, Send, Trash2 } from 'lucide-react-native'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { queuedMessageStyles } from '../../input/queued-messages/mobile-native-chat-queued-message-styles'
import type { MobileQueuedCardActions } from '../../input/queued-messages/mobile-queued-card-actions'
import type { MobileQueuedMessageEdit } from '../../input/queued-messages/use-mobile-structured-queued-message-controls'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'

/** Other agents' waiting mail, drawn after the chat's live activity instead of as cards, and its
 *  actions, kept apart so a new arrival redraws no other row's buttons. */
export type MobileWaitingAgentMail = {
  rows: readonly NativeChatMessage[]
  actions: MobileWaitingAgentMailActionsValue
}

export type MobileWaitingAgentMailActionsValue = {
  /** The queued cards' guard: one action per message at a time. */
  actions: MobileQueuedCardActions
  /** Opens a waiting message in the queue's editor above the composer. */
  edit: MobileQueuedMessageEdit | undefined
  editable: ((messageId: string) => boolean) | undefined
  send: (messageId: string) => Promise<boolean>
  delete: (messageId: string) => Promise<boolean>
  agentWorking: boolean
  /** Stop is ending the turn: nothing steers into it. */
  steerHeld: boolean
}

/** The chat's queue actions, for other agents' mail the transcript draws while it waits. */
export const MobileWaitingAgentMailContext =
  createContext<MobileWaitingAgentMailActionsValue | null>(null)

/** Steer (Send while idle), Edit and Delete on a waiting agent message, as its queued card offered. */
export function MobileWaitingAgentMailActions({
  queuedMessageId
}: {
  queuedMessageId: string
}): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const actions = useContext(MobileWaitingAgentMailContext)
  if (!actions) {
    return null
  }
  const busy = actions.actions.busyIds.has(queuedMessageId)
  const run = (action: (messageId: string) => Promise<boolean>) =>
    actions.actions.run(queuedMessageId, action)
  const steers = actions.agentWorking
  const sendDisabled = busy || actions.steerHeld
  return (
    <View style={styles.actions}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: sendDisabled }}
        accessibilityLabel={
          steers
            ? t('session.queuedMessageCardRow.steerHint', 'Submit without interrupting the model')
            : t('session.queuedMessageCardRow.sendHint', 'Send this message')
        }
        hitSlop={12}
        disabled={sendDisabled}
        onPress={() => run(actions.send)}
        style={({ pressed }) => [
          queuedMessageStyles.steerPill,
          styles.pill,
          pressed && queuedMessageStyles.pressed,
          sendDisabled && styles.disabled
        ]}
      >
        {steers ? (
          <CornerDownRight size={12} color={colors.textPrimary} strokeWidth={2} />
        ) : (
          <Send size={12} color={colors.textPrimary} strokeWidth={2} />
        )}
        <Text style={queuedMessageStyles.steerLabel}>
          {steers
            ? t('session.queuedMessageCardRow.steer', 'Steer')
            : t('session.queuedMessageCardRow.send', 'Send')}
        </Text>
      </Pressable>
      {actions.edit && actions.editable?.(queuedMessageId) ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          accessibilityLabel={t('chat.queuedMessages.editMessage', 'Edit message')}
          hitSlop={12}
          disabled={busy}
          onPress={() => run((messageId) => actions.edit!(messageId))}
          style={({ pressed }) => [
            styles.delete,
            pressed && queuedMessageStyles.pressed,
            busy && styles.disabled
          ]}
        >
          <Pencil size={14} color={colors.textSecondary} strokeWidth={2} />
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
        accessibilityLabel={t('common.delete', 'Delete')}
        hitSlop={12}
        disabled={busy}
        onPress={() => run(actions.delete)}
        style={({ pressed }) => [
          styles.delete,
          pressed && queuedMessageStyles.pressed,
          busy && styles.disabled
        ]}
      >
        <Trash2 size={14} color={colors.textSecondary} strokeWidth={2} />
      </Pressable>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  actions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  // The queue cards' greyed-out look while an action is on its way.
  disabled: { opacity: 0.5 },
  // Sized to the row's line, so a waiting row is as tall as the delivered row that replaces it.
  pill: { minHeight: 20, paddingHorizontal: 8 },
  delete: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10
  }
}))
