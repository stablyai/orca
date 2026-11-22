// An agent asking its owner on an item: a banner and a phone push under its Needs permission switch,
// whose tap opens the item's page.
import type { Bot } from '../../shared/bot-types'
import { botItemQuestionLine } from '../../shared/bots/bot-item-ask'
import { botItemPaneKey } from '../../shared/bots/bot-notification-pane-keys'
import { formatBotItemNumber, type BotItem } from '../../shared/bots/bot-items'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { BotOwnerNoticeDeps } from './bot-could-not-finish'
import type { BotItemEventRecord } from './bot-items-schema'

/** `write`: the events of the agent's write; one that moved the item to Needs you asks. Its move is
 *  its last event, and an earlier ask in the same millisecond can share the group. */
export function notifyBotItemQuestion(
  deps: BotOwnerNoticeDeps,
  bot: Bot | undefined,
  item: BotItem,
  write: readonly BotItemEventRecord[]
): void {
  const asked = write.findLast((event) => event.kind === 'status' && event.data.to === 'needs_you')
  if (!bot || bot.paused || !bot.notifications.needsPermission || !asked) {
    return
  }
  const question = item.question
  const line = question
    ? botItemQuestionLine(question.decisions?.[0]?.question ?? question.gist ?? question.text)
    : ''
  deps.notify({
    id: `bot-item-ask:${item.uid}:${asked.id}`,
    title: `${bot.name} asked you`,
    body: [`${formatBotItemNumber(item.number)} ${item.title}`, line].filter(Boolean).join(' · '),
    worktreeId: folderWorkspaceKey(bot.folderWorkspaceId),
    paneKey: botItemPaneKey(item.uid)
  })
}
