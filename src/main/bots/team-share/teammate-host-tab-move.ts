// TEMPORARY (delete after the next release): an older build wrote the chat a teammate opened on a
// shared agent into the host's own tab list. Each such tab moves to that teammate's own tabs; the
// workspaces moved are returned so their devices are told.
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
import {
  teammateTabSetKey,
  type ClientSessionPersonTabs
} from '../../runtime/client/navigation/client-session-person-tabs'
import { createChatOrcaSessionIdResolver } from '../../runtime/orchestration/addressing/session-lineage/canonical-orca-session-id'
import {
  readBotConversationActsFor,
  type BotConversationActsForSources
} from '../bot-conversation-acts-for'

export async function moveTeammateHostTabs(
  runtime: BotConversationActsForSources & StructuredSessionSurfaceRuntime,
  bots: readonly Pick<Bot, 'id' | 'folderWorkspaceId'>[],
  people: Pick<ClientSessionPersonTabs, 'add'>
): Promise<string[]> {
  const host = getStructuredAgentSessionHost()
  if (!host || host.deps.store.readOnly) {
    return []
  }
  const moved = new Set<string>()
  const rootOf = createChatOrcaSessionIdResolver()
  const botOfHome = new Map<string, (typeof bots)[number]>(
    bots.map((bot) => [folderWorkspaceKey(bot.folderWorkspaceId), bot])
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
        const person = teammateTabSetKey({ botId: bot.id, accountId: asker.userId })
        people.add(person, location.workspaceId, sessionId)
      }
    }
    // The chat keeps working with no host tab, as a teammate's chat always has.
    const surface = captureStructuredSessionSurface(host, sessionId, runtime)
    await retireCapturedStructuredSessionSurface(host, sessionId, surface, runtime, true)
    moved.add(location.workspaceId)
  }
  return [...moved]
}
