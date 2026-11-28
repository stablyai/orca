// A teammate's own tab list in a shared agent's Home is a workspace of its own on the host (`person:`),
// saved in the teammates' session partition. Clients still address the Home; this maps a call to it.
import type { Bot } from '../../../../shared/bot-types'
import type { BotHomeOf } from '../../../../shared/bots/bot-home-of'
import {
  homeOfPersonWorkspace,
  isPersonWorkspaceKey,
  parsePersonWorkspaceKey,
  personWorkspaceKey
} from '../../../../shared/workspace/identity/person-workspace-key'
import { parseWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import {
  callerTabPerson,
  homeTabListOf,
  isTeammateTabList,
  tabListTeammate,
  teammateTabListKey,
  type TabPerson,
  type TeammateTabListKey
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
  return { home: workspaceId, list: personTabListOf(agents, workspaceId, callerTabPerson(scope)) }
}

/** The tab list a person's write on `workspaceId` lands in (`resolveTabListTarget`'s, for a writer
 *  that names its person as data: a chat's stamp, the host's own state). */
export function personTabListOf(
  agents: readonly Pick<Bot, 'id' | 'folderWorkspaceId'>[],
  workspaceId: string,
  person: TabPerson
): string {
  return tabListOfHolder(workspaceId, homeTabListOf(person, workspaceId, agents))
}

/** The workspace a terminal's tab lives in: the teammate's own list that holds it (its record keeps
 *  the Home it runs in, `worktreeId`, and the stamp, `holder`), else the workspace it runs in. The one
 *  join from a PTY to its tab list; reads of the folder it runs in (cwd, git, removal) keep `worktreeId`. */
export function tabListOfPty(pty: { worktreeId: string; holder?: TeammateTabListKey }): string {
  return tabListOfHolder(pty.worktreeId, pty.holder)
}

/** The stamp (`holder`) a terminal or page in `list` takes, and the Home it runs in. */
export function holderOfTabList(list: string): {
  home: string
  holder: TeammateTabListKey | undefined
} {
  const ref = parsePersonWorkspaceKey(list)
  const home = isPersonWorkspaceKey(list) ? homeOfPersonWorkspace(list) : null
  return ref && home
    ? { home, holder: teammateTabListKey({ botId: ref.botId, accountId: ref.accountId }) }
    : { home: list, holder: undefined }
}

/** A list titled as its reader reads it (a teammate's own workspace as their Home, its chats named
 *  for them), still keyed by the list. */
export function titledForItsReader<S extends { worktree: string }, R extends { worktree: string }>(
  snapshot: S,
  title: (asRead: S, reader: BotHomeOf) => R
): R {
  const { home, holder } = holderOfTabList(snapshot.worktree)
  const reader = holder ? { accountId: tabListTeammate(holder).accountId } : 'owner'
  return { ...title({ ...snapshot, worktree: home }, reader), worktree: snapshot.worktree }
}

function tabListOfHolder(workspaceId: string, holder: string | undefined): string {
  const home = parseWorkspaceKey(workspaceId)
  if (!holder || !isTeammateTabList(holder) || home?.type !== 'folder') {
    return workspaceId
  }
  return personWorkspaceKey({
    folderWorkspaceId: home.folderWorkspaceId,
    ...tabListTeammate(holder)
  })
}

/** The one outbound mapping of a workspace id: a teammate's own workspace goes out as their Home, so
 *  no client ever reads a `person:` key; every other id goes as it is. */
export function toWireWorkspaceId(worktreeId: string): string {
  return holderOfTabList(worktreeId).home
}

/** A tab list frame at the outbound boundary (`toWireWorkspaceId`), and whose list it is: the
 *  teammate's (`holder`), whose devices alone get it, or the host's. */
export function toWireTabList<F extends { worktree: string }>(
  frame: F
): { frame: F; list: 'host' | TeammateTabListKey } {
  const { holder } = holderOfTabList(frame.worktree)
  return holder
    ? { frame: { ...frame, worktree: toWireWorkspaceId(frame.worktree) }, list: holder }
    : { frame, list: 'host' }
}

/** Whether the owner's window shows and sizes a PTY, and hears of its fits: not a teammate's own.
 *  A PTY with no record yet is the window's own spawn in flight. */
export function windowShowsPty(
  pty: Pick<RuntimePtyWorktreeRecord, 'holder' | 'worktreeId'> | undefined
): boolean {
  return pty === undefined || windowOwns(tabListOfPty(pty))
}

/** Whether a PTY's facts (output, use, liveness) feed the owner's sidebar, notifications and
 *  devices: the host list's alone, and never one whose list is unknown (no record). */
export function hostListPty(
  pty: Pick<RuntimePtyWorktreeRecord, 'holder' | 'worktreeId'> | undefined
): boolean {
  return pty !== undefined && windowOwns(tabListOfPty(pty))
}

/** Whether a caller hears of a tab list's events: the list their calls on its workspace land in. */
export function callerTakesTabList(
  agents: readonly Pick<Bot, 'id' | 'folderWorkspaceId'>[],
  list: string,
  scope: RpcCallerScope | undefined
): boolean {
  return resolveTabListTarget(agents, toWireWorkspaceId(list), scope).list === list
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
