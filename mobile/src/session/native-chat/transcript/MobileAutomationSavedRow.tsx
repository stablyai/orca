import { useContext } from 'react'
import { useNow } from '../../../hooks/use-now'
import { Text, View } from 'react-native'
import {
  MobileNativeChatBotIdentityContext,
  MobileNativeChatBotWaitsContext
} from '../mobile-native-chat-bot-identity'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import {
  automationRowMark,
  waitRowLabel,
  waitRowStatus,
  waitRowThen,
  waitRowState,
  waitRowTime
} from '../../../../../src/shared/automations/automation-chat-row'
import { automationWhenText } from '../../../bots/mobile-bot-sheet-copy'
import { typography } from '../../../theme/mobile-theme'
import { scaledType, styles as chat } from './messages/mobile-native-chat-message-styles'
import { mobileNativeChatRowId } from './viewport/mobile-native-chat-reading-place'
import { styles } from './mobile-automation-run-row-styles'
import { MobileAutomationRowFrame } from './MobileAutomationRowFrame'
import { MobileWebhookSetupCard } from './bot-cards/MobileWebhookSetupCard'
import { automationHookId } from '../../../../../src/shared/automation-event-triggers'
import {
  MobileAutomationRunMessage,
  useMobileAutomationRowWording
} from './MobileNativeChatAutomationRunRow'

/** A transcript message's automation row (saved, a wait's ending, a run), or null for any other. */
export function mobileAutomationRow(
  message: NativeChatMessage,
  isUser: boolean,
  rowKey: string | undefined,
  fontScale: number
): React.JSX.Element | null {
  if (message.automationSaved || message.waitEnded) {
    return <MobileAutomationSavedMessage message={message} rowKey={rowKey} fontScale={fontScale} />
  }
  if (message.automationRunNotStarted || (isUser && message.automationRun)) {
    return <MobileAutomationRunMessage message={message} rowKey={rowKey} fontScale={fontScale} />
  }
  return null
}

/** A saved automation, a wait, or how a wait ended, as its row; opens to when it runs. */
export function MobileAutomationSavedMessage({
  message,
  rowKey,
  fontScale
}: {
  message: NativeChatMessage
  rowKey?: string
  fontScale: number
}): React.JSX.Element | null {
  const automation = message.automationSaved?.automation ?? message.waitEnded?.automation
  const bot = useContext(MobileNativeChatBotIdentityContext)
  const waits = useContext(MobileNativeChatBotWaitsContext)
  const wording = useMobileAutomationRowWording(
    automation ?? { dtstart: Number.MAX_SAFE_INTEGER, rrule: '' }
  )
  // A minute clock only while a deadline may still pass here, so the row turns Wait over then.
  const now = useNow(
    60_000,
    !message.savedWaitEnded && message.automationSaved?.automation.once?.by !== undefined
  )
  if (!automation) {
    return null
  }
  const { say } = wording
  const waitState = waitRowState(message, bot?.cancelledWaits, now, waits)
  const when = automationWhenText(automation, true)
  const label = waitState
    ? waitRowLabel(waitState, say)
    : say(message.automationSaved?.change === 'updated' ? 'updatedAutomation' : 'createdAutomation')
  const status = waitState
    ? waitRowStatus(automation, waitState, wording)
    : automation.enabled
      ? when
      : say('paused')
  const at = waitState ? waitRowTime(waitState, message.timestamp) : message.timestamp
  const meta = scaledType(typography.metaSize, fontScale, 4)
  const hookId = message.automationSaved ? automationHookId(automation) : null
  if (hookId) {
    // Its URL is what the user needs next, so a webhook automation is a card, not a folded row.
    return (
      <View style={chat.row} testID={mobileNativeChatRowId(rowKey ?? message.id)}>
        <MobileWebhookSetupCard hookId={hookId} name={automation.name} fontScale={fontScale} />
      </View>
    )
  }
  return (
    <View style={chat.row} testID={mobileNativeChatRowId(rowKey ?? message.id)}>
      <MobileAutomationRowFrame
        testID="automation-row"
        mark={automationRowMark(automation)}
        lead={label}
        name={automation.name}
        status={status}
        timestamp={at}
        disclosureKey={`automation-row:${message.id}`}
        fontScale={fontScale}
      >
        {when ? (
          <>
            {waitState ? <Text style={[styles.heading, meta]}>{say('waitsFor')}</Text> : null}
            <Text style={[styles.quoteText, meta]}>{when}</Text>
          </>
        ) : null}
        {waitState?.kind === 'waiting' ? (
          <>
            <Text style={[styles.heading, meta]}>{say('thenLine')}</Text>
            <Text style={[styles.meta, meta]}>{waitRowThen(waitState.once, wording)}</Text>
          </>
        ) : null}
      </MobileAutomationRowFrame>
    </View>
  )
}
