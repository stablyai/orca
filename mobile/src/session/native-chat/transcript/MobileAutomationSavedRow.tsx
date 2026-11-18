import { useContext } from 'react'
import { useNow } from '../../../hooks/use-now'
import { Text, View } from 'react-native'
import {
  MobileNativeChatBotIdentityContext,
  MobileNativeChatBotWaitsContext
} from '../mobile-native-chat-bot-identity'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import {
  automationRowAccessibleName,
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
import { useMobileNativeChatDisclosure } from './viewport/mobile-native-chat-disclosure-store'
import { mobileNativeChatRowId } from './viewport/mobile-native-chat-reading-place'
import { styles } from './mobile-automation-run-row-styles'
import { MobileAutomationRowFrame, mobileAutomationRowTime } from './MobileAutomationRowFrame'
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
  const [open, setOpen] = useMobileNativeChatDisclosure(`automation-row:${message.id}`, false)
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
  const time = at ? mobileAutomationRowTime(at) : null
  const meta = scaledType(typography.metaSize, fontScale, 4)
  return (
    <View style={chat.row} testID={mobileNativeChatRowId(rowKey ?? message.id)}>
      <MobileAutomationRowFrame
        testID="automation-row"
        mark={automationRowMark(automation)}
        name={automation.name}
        meta={[label, status, time].filter(Boolean).join(' · ')}
        accessibilityLabel={automationRowAccessibleName(
          { label, name: automation.name, status, time },
          say
        )}
        open={open}
        onToggle={() => setOpen(!open)}
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
