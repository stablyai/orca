import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { ActionSheetModal } from '../components/sheets/ActionSheetModal'
import { botGroupRoom, type BotGroup } from '../../../src/shared/bots/bot-group'
import type { BotGroupTranscriptAction } from '../../../src/shared/bots/bot-group-transcript'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { groupUpdate } from './bot-group-operations'
import type { PhoneBot } from './host-bots-operations'

/** Who answers the owner's posts: one member, all of them, or only who's mentioned. */
export function MobileBotGroupRepliesSheet({
  visible,
  group,
  threadId,
  bots,
  client,
  apply,
  onError,
  onClose
}: {
  visible: boolean
  group: BotGroup
  /** The room the sheet opened in, whose members the saved group is read for. */
  threadId: string | undefined
  bots: readonly PhoneBot[]
  client: RpcClient
  apply: (action: BotGroupTranscriptAction) => void
  onError: (message: string) => void
  onClose: () => void
}) {
  const t = useMobileTranslation()
  const defaultId = group.replyMode.kind === 'bot' ? group.replyMode.botId : null
  const choose = async (replyMode: BotGroup['replyMode']) => {
    try {
      const result = groupUpdate.interpret(
        await groupUpdate.request(client, {
          groupId: group.id,
          revision: group.revision,
          replyMode
        })
      )
      apply({ kind: 'group', group: botGroupRoom(result.group, threadId) })
      onClose()
    } catch (error) {
      onError(String(error))
    }
  }
  return (
    <ActionSheetModal
      visible={visible}
      title={t('bots.groups.whoAnswers', 'Who answers your messages')}
      actions={[
        ...bots
          .filter((bot) => group.members.some((member) => member.botId === bot.id))
          .map((bot) => ({
            label: bot.name,
            checked: defaultId === bot.id,
            onPress: () => void choose({ kind: 'bot', botId: bot.id }),
            skipAutoClose: true
          })),
        {
          label: t('bots.groups.allBots', 'All bots'),
          checked: group.replyMode.kind === 'all',
          onPress: () => void choose({ kind: 'all' }),
          skipAutoClose: true
        },
        {
          label: t('bots.groups.onlyWhenMentioned', 'Only when mentioned'),
          checked: group.replyMode.kind === 'mentions',
          onPress: () => void choose({ kind: 'mentions' }),
          skipAutoClose: true
        }
      ]}
      onClose={onClose}
    />
  )
}
