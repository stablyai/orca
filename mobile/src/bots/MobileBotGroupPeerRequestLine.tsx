import { Text } from 'react-native'
import type { BotGroupMessage } from '../../../src/shared/bots/bot-group'
import {
  botGroupPeerLine,
  type BotGroupPeerLine
} from '../../../src/shared/bots/bot-group-peer-line'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { groupStyles as styles } from './mobile-bot-group-styles'

// No default: a new peer-line kind must fail the typecheck instead of rendering the wrong text.
function peerLineText(t: Translate, line: BotGroupPeerLine): string {
  switch (line.kind) {
    case 'asked':
      return t('bots.groups.peerAsked', '{{from}} asked {{to}}', line)
    case 'told':
      return t('bots.groups.peerTold', '{{from}} told {{to}}', line)
    case 'read':
      return t('bots.groups.peerReplyRead', "{{reader}} read {{peer}}'s reply", line)
    case 'followed':
      return t('bots.groups.peerFollowedUp', '{{bot}} followed up', line)
    case 'items':
      return t('bots.groups.peerReadItems', '{{bot}} read an update to its items', line)
    case 'paused':
      return t(
        'bots.groups.handoffsPaused',
        'Paused after {{count}} hand-offs. Reply to continue.',
        line
      )
  }
}

/** A bot-to-bot hand-off: who asked or told whom, or whose reply the asker read, between the owner's messages. */
export function MobileBotGroupPeerRequestLine({ message }: { message: BotGroupMessage }) {
  const t = useMobileTranslation()
  return (
    <Text style={[styles.notice, styles.centered]}>
      {peerLineText(t, botGroupPeerLine(message))}
    </Text>
  )
}
