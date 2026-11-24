import { StyleSheet, Text } from 'react-native'
import {
  AUTOMATION_RESULT_NOTE_COPY as COPY,
  type AutomationResultNote
} from '../../../../../src/shared/bots/bot-automation-result-note'
import type { AutomationRowMark } from '../../../../../src/shared/automations/automation-chat-row'
import { sayAutomationRunEnglish as say } from '../../../../../src/shared/automations/automation-run-row-words'
import { MobileNativeChatMarkdown } from './message-content/MobileNativeChatMarkdown'
import { colors, spacing, typography } from '../../../theme/mobile-theme'
import { CHAT_PROSE_SCALE, scaledType } from './messages/mobile-native-chat-message-styles'
import { MobileAutomationRowFrame } from './MobileAutomationRowFrame'

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
  const finished = note.outcome === 'finished'
  const mark: AutomationRowMark = note.trigger === 'schedule' ? 'schedule' : 'event'
  const label = note.trigger === 'schedule' ? say('scheduled') : say('event')
  const status = finished ? say('finished') : say('couldNotFinish')
  return (
    <MobileAutomationRowFrame
      testID="automation-result-row"
      mark={mark}
      lead={label}
      name={note.automationName}
      status={status}
      failed={!finished}
      timestamp={note.at}
      disclosureKey={`automation-result:${note.runId}`}
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
