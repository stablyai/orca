import type { AuthorityRig } from '../../runtime/agent-session/lifecycle/structured-agent-session-tab-authority.test-support'
import { personWorkspaceKey } from '../../../shared/workspace/identity/person-workspace-key'
import { TEAMMATE_HOMES_SESSION_PARTITION } from '../../../shared/workspace-session/teammate-homes-session-partition'

type Teammate = { botId: string; accountId: string }

/** The rig's reads of a teammate's own workspace in the Home, as the host holds it; `mate` by default. */
export function teammateOwnWorkspaceReads(
  opened: AuthorityRig,
  homeFolder: string,
  mate: Teammate
) {
  const listOf = (teammate: Teammate = mate) =>
    personWorkspaceKey({ folderWorkspaceId: homeFolder, ...teammate })
  return {
    listOf,
    /** The chats in a teammate's own workspace, live, and its active tab. */
    mine: (teammate?: Teammate) => {
      const snapshot = opened.runtime['mobileSessionTabsByWorktree'].get(listOf(teammate))
      return {
        chats: (snapshot?.tabs ?? []).flatMap((tab) =>
          tab.type === 'agent-session' ? [tab.sessionId] : []
        ),
        activeTabId: snapshot?.activeTabId ?? null,
        snapshotVersion: snapshot?.snapshotVersion ?? 0
      }
    },
    /** The chats a teammate's own workspace saves, in the teammates' partition. */
    mineSaved: (teammate?: Teammate) =>
      (
        opened.profile.getWorkspaceSession(TEAMMATE_HOMES_SESSION_PARTITION).unifiedTabs?.[
          listOf(teammate)
        ] ?? []
      ).flatMap((tab) => (tab.contentType === 'agent-session' ? [tab.entityId] : []))
  }
}
