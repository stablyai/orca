import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { botHomeSessionId, withBotHomePins } from '../../session-tabs/chat/bot-home-snapshot'
import { projectRuntimeMobileSessionTabs } from './runtime-mobile-session-projection'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'

/** The client payload, with a bot's Home pinned and its side chats unpinned; derived here, never persisted. */
export function projectTabsWithBotHomePins(
  store: Parameters<typeof botHomeSessionId>[0],
  snapshot: RuntimeMobileSessionTabsSnapshot,
  host: RuntimeMobileSessionProjectionHost
): RuntimeMobileSessionTabsResult {
  const result = projectRuntimeMobileSessionTabs(snapshot, host)
  const homeSessionId = botHomeSessionId(store, snapshot.worktree)
  return homeSessionId ? withBotHomePins(result, homeSessionId) : result
}
