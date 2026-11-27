// The one decision of rule 4 (teammate-rules.ts) for the host's own tab list and window: a teammate's
// call never writes the host's list of, nor opens or focuses a host window tab in, a workspace whose
// list is not shared (their own Home, or the owner's). Installed at the store's single write point
// (MobileSessionSnapshotsByWorktree) and at the host window's two entry points.
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { Bot } from '../../../../shared/bot-types'
import { tabOwnerOf } from '../../../bots/team-share/teammate-rules'
import { getActiveTeammate } from '../../rpc/callers/active-call'

export class TeammateHostTabWriteError extends Error {
  constructor(worktreeId: string | null, what: string) {
    super(`teammate_host_tab_write: ${what} in ${worktreeId ?? 'no workspace'}`)
    this.name = 'TeammateHostTabWriteError'
  }
}

type Bots = () => readonly Pick<Bot, 'id' | 'folderWorkspaceId'>[]

/** Whether the active call may change the host's tabs of this workspace; a missing workspace is not. */
export function activeCallMayTouchHostTabs(worktreeId: string | null, bots: Bots): boolean {
  const teammate = getActiveTeammate()
  return !teammate || (worktreeId !== null && tabOwnerOf(worktreeId, teammate, bots()) === 'shared')
}

function changesTabs(
  previous: RuntimeMobileSessionTabsSnapshot | undefined,
  next: RuntimeMobileSessionTabsSnapshot | undefined
): boolean {
  if (!previous || !next) {
    return (previous?.tabs.length ?? 0) > 0 || (next?.tabs.length ?? 0) > 0
  }
  return (
    previous.activeTabId !== next.activeTabId ||
    previous.tabs.length !== next.tabs.length ||
    previous.tabs.some((tab, index) => tab.id !== next.tabs[index]?.id)
  )
}

/** The store's write admission: a teammate's call that would open, close, move or activate a tab of
 *  a host list it may not touch throws. Version and status refreshes pass. */
export function hostTabListWriteAdmission(bots: Bots) {
  return (
    worktreeId: string,
    previous: RuntimeMobileSessionTabsSnapshot | undefined,
    next: RuntimeMobileSessionTabsSnapshot | undefined
  ): void => {
    if (changesTabs(previous, next) && !activeCallMayTouchHostTabs(worktreeId, bots)) {
      throw new TeammateHostTabWriteError(worktreeId, 'host tab list write')
    }
  }
}
