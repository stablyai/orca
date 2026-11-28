// A teammate's own tab list in a shared agent's Home is a workspace of its own on the host (`person:`),
// saved in the teammates' session partition. Clients still address the Home; this maps a call to it.
import type { Bot } from '../../../../shared/bot-types'
import {
  isPersonWorkspaceKey,
  personWorkspaceKey
} from '../../../../shared/workspace/identity/person-workspace-key'
import { parseWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import {
  callerTabPerson,
  homeTabListOf,
  isTeammateTabList,
  tabListTeammate,
  type TabPerson
} from '../../../bots/team-share/teammate-rules'
import type { RpcCallerScope } from '../../rpc/callers/rpc-caller-scope'

/** `home` is the workspace the caller named; `list` is the workspace whose tabs the call reads and writes. */
export type TabListTarget = { home: string; list: string }

/** Whether this workspace's tabs are the owner's window's to show and write, if the host has a window;
 *  false for a teammate's own list, which is the host's alone. It never checks for a window: on a
 *  host without one (orcad, headless) every workspace still takes the headless path. */
export function windowOwns(worktreeId: string): boolean {
  return !isPersonWorkspaceKey(worktreeId)
}

/** The tab list a caller's call on `workspaceId` (a resolved workspace key) lands in: a teammate's own
 *  in their agent's Home, the workspace itself for everyone and everywhere else. Nothing needs creating
 *  first: a layout command on an absent workspace opens it. */
export function resolveTabListTarget(
  agents: readonly Pick<Bot, 'id' | 'folderWorkspaceId'>[],
  workspaceId: string,
  scope: RpcCallerScope | undefined
): TabListTarget {
  return { home: workspaceId, list: personTabListOf(agents, workspaceId, callerTabPerson(scope)) }
}

/** The workspace a write for `person` lands in: their own in their agent's Home, else `workspaceId`. */
export function personTabListOf(
  agents: readonly Pick<Bot, 'id' | 'folderWorkspaceId'>[],
  workspaceId: string,
  person: TabPerson
): string {
  const list = homeTabListOf(person, workspaceId, agents)
  const home = parseWorkspaceKey(workspaceId)
  if (!isTeammateTabList(list) || home?.type !== 'folder') {
    return workspaceId
  }
  return personWorkspaceKey({ folderWorkspaceId: home.folderWorkspaceId, ...tabListTeammate(list) })
}
