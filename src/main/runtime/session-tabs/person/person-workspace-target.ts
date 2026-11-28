// A teammate's own tab list in a shared agent's Home is a workspace of its own on the host (`person:`),
// saved in the teammates' session partition. Clients still address the Home; this maps a call to it.
import type { Bot } from '../../../../shared/bot-types'
import {
  isPersonWorkspaceKey,
  personWorkspaceKey
} from '../../../../shared/workspace/identity/person-workspace-key'
import { parseWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import {
  isTeammateTabList,
  tabListTeammate,
  tabOwnerOf
} from '../../../bots/team-share/teammate-rules'
import type { RpcCallerScope } from '../../rpc/callers/rpc-caller-scope'
import type { RuntimePtyWorktreeRecord } from '../../terminal/records/runtime-terminal-state-records'

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

/** The workspace whose tabs hold a terminal: its holder's own list, else the one it runs in. */
export function tabListOfPty(pty: Pick<RuntimePtyWorktreeRecord, 'worktreeId' | 'holder'>): string {
  const home = parseWorkspaceKey(pty.worktreeId)
  if (!pty.holder || home?.type !== 'folder') {
    return pty.worktreeId
  }
  return personWorkspaceKey({
    folderWorkspaceId: home.folderWorkspaceId,
    ...tabListTeammate(pty.holder)
  })
}

/** Whether a PTY's facts (output, use, liveness) feed the owner's sidebar, notifications and
 *  devices: the host list's alone, and never one whose list is unknown (no record). */
export function hostListPty(
  pty: Pick<RuntimePtyWorktreeRecord, 'holder' | 'worktreeId'> | undefined
): boolean {
  return pty !== undefined && windowOwns(tabListOfPty(pty))
}
