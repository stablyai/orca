// A teammate's own tab list in a shared agent's Home is a workspace of its own on the host (`person:`),
// saved in the teammates' session partition. Clients still address the Home; this maps a call to it.
import type { Bot } from '../../../../shared/bot-types'
import {
  isPersonWorkspaceKey,
  parsePersonWorkspaceKey,
  personWorkspaceKey
} from '../../../../shared/workspace/identity/person-workspace-key'
import { parseWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import {
  isTeammateTabList,
  tabListTeammate,
  tabOwnerOf,
  teammateTabListKey
} from '../../../bots/team-share/teammate-rules'
import type { RpcCallerScope } from '../../rpc/callers/rpc-caller-scope'
import type {
  PtyList,
  RuntimePtyWorktreeRecord
} from '../../terminal/records/runtime-terminal-state-records'

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
  const owner = tabOwnerOf(workspaceId, scope?.kind === 'bot-share' ? scope : null, agents)
  const home = parseWorkspaceKey(workspaceId)
  if (!isTeammateTabList(owner) || home?.type !== 'folder') {
    return { home: workspaceId, list: workspaceId }
  }
  const list = personWorkspaceKey({
    folderWorkspaceId: home.folderWorkspaceId,
    ...tabListTeammate(owner)
  })
  return { home: workspaceId, list }
}

/** The tab list a PTY is in: its holder's own workspace, else the workspace it runs in. */
export function tabListOfPty(pty: Pick<RuntimePtyWorktreeRecord, 'holder' | 'worktreeId'>): string {
  const home = parseWorkspaceKey(pty.worktreeId)
  return pty.holder && home?.type === 'folder'
    ? personWorkspaceKey({
        folderWorkspaceId: home.folderWorkspaceId,
        ...tabListTeammate(pty.holder)
      })
    : pty.worktreeId
}

/** Whether the owner's window shows a PTY, and so sizes it; a record not yet made is the window's. */
export function windowShowsPty(
  pty: Pick<RuntimePtyWorktreeRecord, 'holder' | 'worktreeId'> | undefined
): boolean {
  return !pty || windowOwns(tabListOfPty(pty))
}

/** The PTYs a caller's workspace-wide act takes (`ptyInList`): their own in their agent's Home, the
 *  host's list's everywhere else. */
export function callerListIn(
  agents: readonly Pick<Bot, 'id' | 'folderWorkspaceId'>[],
  workspaceId: string,
  scope: RpcCallerScope | undefined
): PtyList {
  const person = parsePersonWorkspaceKey(resolveTabListTarget(agents, workspaceId, scope).list)
  return person ? teammateTabListKey(person) : 'host'
}
