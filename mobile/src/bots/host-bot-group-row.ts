import type { BotGroup } from '../../../src/shared/bots/bot-group'
import { botGroupStatusOf } from '../../../src/shared/bots/bot-group-status'
import { botGroupMemberBots } from '../../../src/shared/bots/bot-sidebar-entries'
import type { WorkspaceListItem, Worktree } from '../worktree/workspace-list/workspace-list-types'
import { mobileBotAvatarSource } from './host-bot-row-facts'
import type { ListedBot } from './host-bots-operations'

type AgentRow = NonNullable<Worktree['agents']>[number]

/** Every agent row on one host's page by pane key, where a group's member sessions are found. */
export function hostAgentsByPaneKey(rows: readonly Worktree[]): ReadonlyMap<string, AgentRow> {
  return new Map(
    rows.flatMap((row) => (row.agents ?? []).map((agent) => [agent.paneKey, agent] as const))
  )
}

/** A group's row in the Bots list, drawn over its hidden home's row as the desktop draws the room. */
export function hostBotGroupRow(input: {
  group: BotGroup
  drawnHome: WorkspaceListItem
  sectionListKey: string
  bots: readonly ListedBot[]
  agentByPaneKey: ReadonlyMap<string, AgentRow>
}): WorkspaceListItem {
  const { group, drawnHome } = input
  return {
    row: { ...drawnHome.row, displayName: group.name },
    view: {
      ...drawnHome.view,
      sectionListKey: input.sectionListKey,
      lineageDepth: 0,
      projectGroupDepth: 0,
      inFolderScanGroup: false,
      botGroupFacts: {
        group,
        members: botGroupMemberBots(group, input.bots).map((bot) => ({
          id: bot.id,
          name: bot.name,
          avatar: mobileBotAvatarSource(bot)
        })),
        dot: botGroupStatusOf(group, (paneKey) => input.agentByPaneKey.get(paneKey))
      }
    }
  }
}
