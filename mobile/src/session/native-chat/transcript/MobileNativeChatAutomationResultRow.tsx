import { StyleSheet, Text } from 'react-native'
import {
  AUTOMATION_RESULT_NOTE_COPY as COPY,
  type AutomationResultNote
} from '../../../../../src/shared/bots/bot-automation-result-note'
import {
  automationRowAccessibleName,
  type AutomationRowMark
} from '../../../../../src/shared/automations/automation-chat-row'
import { sayAutomationRunEnglish as say } from '../../../../../src/shared/automations/automation-run-row-words'
import { MobileNativeChatMarkdown } from './message-content/MobileNativeChatMarkdown'
import { colors, spacing, typography } from '../../../theme/mobile-theme'
import { CHAT_PROSE_SCALE, scaledType } from './messages/mobile-native-chat-message-styles'
import { useMobileNativeChatDisclosure } from './viewport/mobile-native-chat-disclosure-store'
import { MobileAutomationRowFrame, mobileAutomationRowTime } from './MobileAutomationRowFrame'

/** An automation run's result in its bot's Chat, as its row; opens into the result. */
export function MobileNativeChatAutomationResultRow({
  note,
  cleared = false,
  fontScale
}: {
  note: AutomationResultNote
  /** A later /clear left it unread for good. */
  cleared?: boolean
  fontScale: number
}): React.JSX.Element {
  const [open, setOpen] = useMobileNativeChatDisclosure(`automation-result:${note.runId}`, false)
  const finished = note.outcome === 'finished'
  const mark: AutomationRowMark = note.trigger === 'schedule' ? 'schedule' : 'event'
  const label = note.trigger === 'schedule' ? say('scheduled') : say('event')
  const status = finished ? say('finished') : say('couldNotFinish')
  const time = mobileAutomationRowTime(note.at)
  return (
    <MobileAutomationRowFrame
      testID="automation-result-row"
      mark={mark}
      name={note.automationName}
      meta={[label, status, time].join(' · ')}
      failed={!finished}
      accessibilityLabel={automationRowAccessibleName(
        { label, name: note.automationName, status, time },
        say
      )}
      open={open}
      onToggle={() => setOpen(!open)}
      fontScale={fontScale}
    >
      <MobileNativeChatMarkdown
        content={note.result}
        rangeSelectable
        textScale={CHAT_PROSE_SCALE * fontScale}
      />
      <Text style={[styles.caption, scaledType(typography.metaSize, fontScale, 4)]}>
        {(note.readWith !== undefined ? COPY.read : cleared ? COPY.cleared : COPY.notRead).replace(
          '{{name}}',
          note.botName
        )}
      </Text>
    </MobileAutomationRowFrame>
  )
}

const styles = StyleSheet.create({
  caption: {
    marginTop: spacing.xs,
    color: colors.textMuted
  }
})
