import type { AutomationResultNote } from '../../../../../src/shared/bots/bot-automation-result-note'
import type { AutomationRowMark } from '../../../../../src/shared/automations/automation-chat-row'
import { sayAutomationRunEnglish as say } from '../../../../../src/shared/automations/automation-run-row-words'
import { MobileNativeChatMarkdown } from './message-content/MobileNativeChatMarkdown'
import { CHAT_PROSE_SCALE } from './messages/mobile-native-chat-message-styles'
import { MobileAutomationRowFrame } from './MobileAutomationRowFrame'

/** An automation run's result in its bot's Chat, as its row; opens into the result when it has one. */
export function MobileNativeChatAutomationResultRow({
  note,
  fontScale
}: {
  note: AutomationResultNote
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
      {note.result ? (
        <MobileNativeChatMarkdown
          content={note.result}
          rangeSelectable
          textScale={CHAT_PROSE_SCALE * fontScale}
        />
      ) : null}
    </MobileAutomationRowFrame>
  )
}
