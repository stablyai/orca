import { Text } from 'react-native'
import type { BotGroupMessage } from '../../../src/shared/bots/bot-group'
import { botGroupPeerLine } from '../../../src/shared/bots/bot-group-peer-line'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { groupStyles as styles } from './mobile-bot-group-styles'

/** A bot-to-bot hand-off: who asked whom, or whose reply the asker read, between the owner's messages. */
export function MobileBotGroupPeerRequestLine({ message }: { message: BotGroupMessage }) {
  const t = useMobileTranslation()
  const line = botGroupPeerLine(message)
  return (
    <Text style={[styles.notice, styles.centered]}>
      {line.kind === 'asked'
        ? t('bots.groups.peerAsked', '{{from}} asked {{to}}', line)
        : line.kind === 'read'
          ? t('bots.groups.peerReplyRead', "{{reader}} read {{peer}}'s reply", line)
          : t('bots.groups.peerFollowedUp', '{{bot}} followed up', line)}
    </Text>
  )
}
