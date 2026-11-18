import { createContext, useContext, type ComponentProps } from 'react'
import { Text } from 'react-native'
import { quietBotAnswerBlocks } from '../../../../../../src/shared/bot-quiet-result'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { MobileNativeChatBotIdentityContext } from '../../mobile-native-chat-bot-identity'
import { scaledType, styles } from '../messages/mobile-native-chat-message-styles'
import { MobileNativeChatPacedProse } from './MobileNativeChatPacedProse'

/** The row is in a turn an automation's row opened, which already says what ran. */
export const MobileNativeChatAutomationTurnContext = createContext(false)

/** An agent row's prose; in a bot's chat a quiet result shows as a line, not its marker, as on the desktop. */
export function MobileNativeChatAnswerProse({
  blocks,
  fontScale,
  ...prose
}: ComponentProps<typeof MobileNativeChatPacedProse> & { fontScale: number }): React.JSX.Element {
  const t = useMobileTranslation()
  const bot = useContext(MobileNativeChatBotIdentityContext)
  // Paced prose is an assistant's own reply; another agent's message draws as its card.
  const answer = quietBotAnswerBlocks(blocks, {
    botAnswer: prose.paced && bot?.botId !== undefined,
    streaming: prose.growingBlock !== undefined,
    inAutomationTurn: useContext(MobileNativeChatAutomationTurnContext)
  })
  return (
    <>
      <MobileNativeChatPacedProse {...prose} blocks={answer.blocks} />
      {answer.nothingToReport ? (
        <Text style={[styles.hostNotice, scaledType(13, fontScale)]}>
          {t('bots.chat.nothingToReport', 'Nothing to report')}
        </Text>
      ) : null}
    </>
  )
}
