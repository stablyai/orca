// TEMPORARY (delete after the next release): an older build wrote the chat a teammate opened on a
// shared agent into the host's own tab list. Each such tab moves to that teammate's own list in the
// agent's Home, once (a moved chat has no host tab left to find); the lists moved into are returned
// so their devices are told.
import { opensHostTab } from '../../../shared/bots/bot-acts-for'
import type { Bot } from '../../../shared/bot-types'
import { isReopenedChatTabId } from '../../../shared/agent-session/view/structured-agent-session-host-tab-id'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  captureStructuredSessionSurface,
  retireCapturedStructuredSessionSurface,
  type StructuredSessionSurfaceRuntime
} from '../../runtime/agent-session/lifecycle/structured-agent-session-close'
import type { PersonSessionTabLists } from '../../runtime/session-tabs/person/person-session-tab-lists'
import { teammateTabListKey, type TeammateTabListKey } from './teammate-rules'
import { createChatOrcaSessionIdResolver } from '../../runtime/orchestration/addressing/session-lineage/canonical-orca-session-id'
import {
  readBotConversationActsFor,
  type BotConversationActsForSources
} from '../bot-conversation-acts-for'

export async function moveTeammateHostTabs(
  runtime: BotConversationActsForSources & StructuredSessionSurfaceRuntime,
  bots: readonly Pick<Bot, 'id' | 'folderWorkspaceId'>[],
  lists: Pick<PersonSessionTabLists, 'open' | 'movedHome' | 'markHomeMoved'>
): Promise<{ person: TeammateTabListKey; worktreeId: string }[]> {
  const host = getStructuredAgentSessionHost()
  if (!host || host.deps.store.readOnly) {
    return []
  }
  const moved = new Map<string, { person: TeammateTabListKey; worktreeId: string }>()
  const rootOf = createChatOrcaSessionIdResolver()
  // Once per Home: after that, every tab in the host's list there is one the owner opened.
  const botOfHome = new Map<string, (typeof bots)[number]>(
    bots.flatMap((bot) => {
      const home = folderWorkspaceKey(bot.folderWorkspaceId)
      return lists.movedHome(home) ? [] : [[home, bot] as const]
    })
  )
  for (const { sessionId, location } of host.deps.store.listConversations()) {
    const bot = botOfHome.get(location.workspaceId)
    const tabId = bot ? host.getSessionTabId(sessionId) : null
    // Only a paired caller's reveal mints a reopened id; a tab the owner opened here keeps its own.
    if (!bot || !tabId || !isReopenedChatTabId(tabId)) {
      continue
    }
    const actsFor = readBotConversationActsFor(runtime, rootOf(sessionId))?.actsFor
    if (!actsFor || opensHostTab(actsFor)) {
      continue
    }
    for (const asker of actsFor) {
      if (asker.kind === 'person' && asker.source === 'orca') {
        const person = teammateTabListKey({ botId: bot.id, accountId: asker.userId })
        lists.open(person, location.workspaceId, sessionId, false)
        moved.set(`${person}\n${location.workspaceId}`, {
          person,
          worktreeId: location.workspaceId
        })
      }
    }
    // The chat keeps working with no host tab, as a teammate's chat always has.
    const surface = captureStructuredSessionSurface(host, sessionId, runtime)
    await retireCapturedStructuredSessionSurface(host, sessionId, surface, runtime, true)
  }
  botOfHome.forEach((_bot, home) => lists.markHomeMoved(home))
  return [...moved.values()]
}
