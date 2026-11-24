// A bot's worker as a row: under its chat in the chat tree, and in an item's Links.
import { View } from 'react-native'
import { CircleX } from 'lucide-react-native'
import { AGENT_FAILURE_COLOR, AgentStateDot } from '../agents/presentation/AgentStateDot'
import { ListRow } from '../components/list/ListGroup'
import { useNow } from '../hooks/use-now'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import type { BotChatTreeWorker } from '../../../src/shared/bots/bot-chat-tree'
import { formatNativeChatDuration } from '../../../src/shared/native-chat/transcript/turns/native-chat-turn-status'

export type TreeBot = { id: string; name: string }

function WorkerIcon({ state }: { state: BotChatTreeWorker['state'] }) {
  switch (state) {
    case 'running':
    case 'asking-bot':
      return <AgentStateDot state="working" />
    case 'unreachable':
      return <AgentStateDot state="unverifiable" />
    case 'needs-you':
      return <AgentStateDot state="permission" decorative />
    case 'done':
      return <AgentStateDot state="done" />
    case 'failed':
      return <CircleX size={13} color={AGENT_FAILURE_COLOR} />
  }
}

/** A worker's row, as a chat lists it and an item's Links list it (`nested: false`). */
export function MobileBotWorkerRow({
  bot,
  worker,
  onOpen,
  onLongPress,
  nested = true
}: {
  bot: TreeBot
  worker: BotChatTreeWorker
  onOpen: (() => void) | undefined
  onLongPress?: () => void
  nested?: boolean
}) {
  const t = useMobileTranslation()
  const counting = worker.state === 'running'
  const now = useNow(1_000, counting)
  const end = counting ? now : worker.settledAt
  const value =
    worker.state === 'needs-you'
      ? t('bots.chats.needsYou', 'Needs you')
      : worker.state === 'asking-bot'
        ? t('bots.chats.askingBot', 'Asking {{name}}', { name: bot.name })
        : worker.state === 'unreachable'
          ? t('bots.chats.statusUnknown', 'Status unknown')
          : end === undefined
            ? undefined
            : formatNativeChatDuration(Math.max(0, (end - worker.startedAt) / 1000))
  const note =
    worker.note === 'handed-over'
      ? t('bots.chats.handedOver', 'Handed over')
      : worker.note === 'from-closed-chat'
        ? t('bots.chats.fromClosedChat', 'From closed chat')
        : worker.note === 'automation-terminal'
          ? t('bots.chats.automationTerminal', 'Automation run · terminal')
          : null
  const line2 = [note, worker.branch].filter(Boolean).join(' · ')
  return (
    <View style={nested ? styles.nested : undefined}>
      <ListRow
        title={worker.title || t('bots.chats.untitledWorker', 'Worker')}
        subtitle={line2 || undefined}
        leading={<WorkerIcon state={worker.state} />}
        value={value}
        onPress={onOpen}
        onLongPress={onLongPress}
        disabled={!onOpen}
      />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  // Indent only, no guide line: a worker sits one step under its chat.
  nested: { paddingLeft: spacing.xl }
}))
