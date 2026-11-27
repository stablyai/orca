import { createContext, useContext, type ComponentProps } from 'react'
import { Text } from 'react-native'
import { quietBotAnswerBlocks } from '../../../../../../src/shared/bot-quiet-result'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { MobileNativeChatBotIdentityContext } from '../../mobile-native-chat-bot-identity'
import { scaledType, stylesSheet } from '../messages/mobile-native-chat-message-styles'
import { MobileNativeChatPacedProse } from './MobileNativeChatPacedProse'
import { useThemedStyles } from '../../../../theme/themed-styles'

/** Whether an automation's row opened the row's turn, and whether the turn said or did something
 *  others see; either already accounts for a quiet result. */
export const MobileNativeChatQuietTurnContext = createContext({
  inAutomationTurn: false,
  inActingTurn: false
})

/** An agent row's prose; where a bot speaks (its chat, a group room's turn) a quiet result shows as
 *  a line, not its marker, as on the desktop. */
export function MobileNativeChatAnswerProse({
  blocks,
  fontScale,
  ...prose
}: ComponentProps<typeof MobileNativeChatPacedProse> & { fontScale: number }): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const bot = useContext(MobileNativeChatBotIdentityContext)
  // Paced prose is an assistant's own reply; another agent's message draws as its card.
  const answer = quietBotAnswerBlocks(blocks, {
    botAnswer: prose.paced && bot !== null,
    streaming: prose.growingBlock !== undefined,
    ...useContext(MobileNativeChatQuietTurnContext)
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
