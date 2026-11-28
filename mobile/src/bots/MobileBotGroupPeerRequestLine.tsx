import { View } from 'react-native'
import { CornerDownRight, Pause } from 'lucide-react-native'
import type { BotGroupMessage } from '../../../src/shared/bots/bot-group'
import {
  botGroupPeerLine,
  type BotGroupPeerLine
} from '../../../src/shared/bots/bot-group-peer-line'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  MobileNativeChatEventName,
  MobileNativeChatEventRow
} from '../session/native-chat/transcript/messages/MobileNativeChatEventRow'
import { stylesSheet } from '../session/native-chat/transcript/messages/mobile-native-chat-message-styles'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import { useThemedStyles } from '../theme/themed-styles'

// No default: a new peer-line kind must fail the typecheck instead of rendering the wrong text.
function peerLineText(t: Translate, line: BotGroupPeerLine): string {
  switch (line.kind) {
    case 'asked':
      return t('bots.groups.peerAsked', '{{from}} asked {{to}}', line)
    case 'told':
      return t('bots.groups.peerTold', '{{from}} told {{to}}', line)
    case 'read':
      return t('bots.groups.peerReadReplyFrom', '{{reader}} read the reply from {{peer}}', line)
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

// Names come back wrapped in this mark, so the drawn line can set them in primary text.
const MARK = '\u0001'

/** The line's names marked, wherever the language puts them. */
function marked(line: BotGroupPeerLine): BotGroupPeerLine {
  const mark = (name: string) => `${MARK}${name}${MARK}`
  switch (line.kind) {
    case 'asked':
    case 'told':
      return { ...line, from: mark(line.from), to: mark(line.to) }
    case 'read':
      return { ...line, reader: mark(line.reader), peer: mark(line.peer) }
    case 'followed':
    case 'items':
      return { ...line, bot: mark(line.bot) }
    case 'paused':
      return line
  }
}

/** A bot-to-bot hand-off, as one quiet line over the turn it starts: who asked or told whom, or whose reply the asker read. */
export function MobileBotGroupPeerRequestLine({ message }: { message: BotGroupMessage }) {
  const messageStyles = useThemedStyles(stylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const line = botGroupPeerLine(message)
  const parts = peerLineText(t, marked(line)).split(MARK)
  const [before, first, between, second, after] = parts
  const Icon = line.kind === 'paused' ? Pause : CornerDownRight
  return (
    <View style={messageStyles.row}>
      <MobileNativeChatEventRow
        icon={<Icon size={14} color={colors.textMuted} strokeWidth={2} />}
        label={parts.join('')}
        fontScale={1}
        wordsLines={2}
      >
        {/* Words, a name, words, a name, words: at most two names, in whatever order the language puts them. */}
        {before}
        {first ? <MobileNativeChatEventName>{first}</MobileNativeChatEventName> : null}
        {between}
        {second ? <MobileNativeChatEventName>{second}</MobileNativeChatEventName> : null}
        {after}
      </MobileNativeChatEventRow>
    </View>
  )
}
