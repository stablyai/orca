// What a teammate (a caller whose scope is a share, `callerScope.kind === 'bot-share'`) reaches on the
// host, as one rule list. Each rule is decided once, from the caller scope stamped at admission
// (`botShareCallerScopeOf`); handlers and the tab store get the answer, never re-check the caller.
//
//  1. Methods. A teammate calls only what teammate-method-classes.json admits: the workspace tier by
//     its class (`scoped` | `filtered` | `own`; unlisted is `refused`), a chats-only teammate by each
//     method's `share` rule. `teammateMethodClass`. A teammate reaches every chat of the shared
//     agent, whoever it is for (`botShareReachesSession`); whose a chat is decides only how it lists.
//  2. Workspaces. Every list and stream a teammate reads is kept to the shared agent's workspaces (its
//     Home and its workers' worktrees): `filtered` methods, through `withTeammateLists` or their
//     handlers (`TEAMMATE_HANDLER_FILTERED`, teammate-workspace-view.ts).
//  3. Host window. Nothing a teammate calls opens, focuses or drives the host's own window:
//     `reachesHostWindow` refuses by each reachable method's `hostWindow` class, and a host-list call
//     naming no workspace (the window would pick one) is refused at admission. A teammate person's
//     chat tab write never reaches the window. Worker workspaces are as for anyone.
//  4. Tabs. Each person on the host has their own tab list in the agent's Home; every other workspace
//     has one list, shared by everyone who can reach it. Every Home tab write names its person
//     (`TabPerson`) as data, never from ambient state: a user action the caller's
//     (`callerTabPerson`, read from the request's scope at the handler), a system write about a chat
//     the chat's stamp (`chatTabPerson`: whom it acts for, written once when it starts), the host's
//     own terminals and saved tabs `HOST_STATE_PERSON`. `homeTabListOf` names the list it lands in:
//     a teammate's own in their agent's Home, the host's everywhere else, so the owner's list only
//     ever takes owner writes. A teammate's Home list holds their chats and the terminals, pages and
//     files they open there. Their list holds each before it starts; a terminal's PTY record and a
//     page's record take the stamp (`holder`) when made, and every door that places a tab in a host
//     list or window reads it (the host's snapshot store, pane admission, orphan adoption, restored
//     placement, exit retirement, the page selection). Every reader that lists or acts on a
//     workspace's terminals or pages for someone takes that list (`ptyInList`, `pagesOf`); only work
//     on the workspace itself reads them all. Stopping or closing all of a Home's terminals takes the
//     caller's own list; other `homeTabs.hostList` methods (incl. sleeping them) are refused at
//     admission when they name the teammate's Home.
//     Reads and streams use the device's list (`tabOwnerOf`), or the list a read names
//     (`viewedTabListOf`): anyone may watch anyone's list in the Home; watching writes nothing, and
//     closing a tab there names that list's person. The census test checks every write's person source.
//  5. Name and asker. A teammate is named by their share row's `name`, and every chat or turn they start
//     acts for them (`botShareAsker`).
//  6. Read marks. The host's read marks (a chat's unread, notification attention, a workspace's unread,
//     a thread's "new") are the owner's: a teammate's open or read never writes them, and none is read
//     out to them as theirs (`ownsHostReadMarks`, checked inside each writer on the reader it is handed).
import classes from '../../runtime/rpc/callers/teammate-method-classes.json'
import { z } from 'zod'
import {
  navigationTargetsHost,
  RUNTIME_NAVIGATION_TARGETS
} from '../../../shared/remote-runtime/session-graph/runtime-navigation'
import type { Bot } from '../../../shared/bot-types'
import type { RpcCallerScope } from '../../runtime/rpc/callers/rpc-caller-scope'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'

// ── 1. Methods ──────────────────────────────────────────────────────────────────────────────────

/** `scoped`: acts on what its params name, as the owner's call would (only lists are kept to the
 *  agent's workspaces). `filtered`: a list or stream kept to the agent's workspaces. `own`: bound to the
 *  caller's own connection, uploads, subscriptions or device. `refused`: the owner's own host,
 *  accounts, settings or other workspaces. */
export type TeammateMethodClass = 'scoped' | 'filtered' | 'own' | 'refused'

export const TEAMMATE_METHOD_CLASSES: readonly TeammateMethodClass[] = [
  'scoped',
  'filtered',
  'own',
  'refused'
]
const CLASS_BY_METHOD: ReadonlyMap<string, TeammateMethodClass> = new Map(
  TEAMMATE_METHOD_CLASSES.flatMap((kind) =>
    classes[kind].map((name: string) => [name, kind] as const)
  )
)

export function teammateMethodClass(methodName: string): TeammateMethodClass {
  return CLASS_BY_METHOD.get(methodName) ?? 'refused'
}

/** Every classified method, for the census test. */
export const TEAMMATE_METHOD_CLASS_TABLE = classes

// ── 3. Host window ──────────────────────────────────────────────────────────────────────────────

export type HostWindowCondition = keyof typeof classes.hostWindow.conditional
/** The caller, and which paired device hosts a browser page (undefined for a host page). */
export type HostWindowCaller = {
  pairedDeviceId?: string
  pageDeviceOf: (browserPageId: string) => string | undefined
}

// Each field on its own: a method whose key of the same name has another shape (agent.launch's
// `placement`) drops only that field, never the navigation or activation checks beside it.
const HostWindowParams = lazyZodSchema(() =>
  z.looseObject({
    navigation: z.enum(RUNTIME_NAVIGATION_TARGETS).optional().catch(undefined),
    activate: z.boolean().optional().catch(undefined),
    runHooks: z.boolean().optional().catch(undefined),
    focus: z.boolean().optional().catch(undefined),
    page: z.string().optional().catch(undefined),
    placement: z.looseObject({ kind: z.string() }).optional().catch(undefined)
  })
)
type HostWindowParams = z.infer<typeof HostWindowParams>

/** A page the caller's own computer hosts: pageless commands fall back to the host's active tab. */
function ownClientPage(params: HostWindowParams, caller: HostWindowCaller): boolean {
  const owner = params.page ? caller.pageDeviceOf(params.page) : undefined
  return caller.pairedDeviceId !== undefined && owner === caller.pairedDeviceId
}

/** Each condition: true when these params stay off the host's window. */
export const HOST_WINDOW_CONDITIONS: Record<
  HostWindowCondition,
  (params: HostWindowParams, caller: HostWindowCaller) => boolean
> = {
  // Without a client kind the create activates on the host unless it names the caller; running its
  // hooks activates it as `activate` does.
  activatesOnlyForCaller: (params) =>
    (params.activate !== true && params.runHooks !== true) || params.navigation === 'caller',
  // Omitted navigation publishes the reveal for every screen, the host's included.
  callerNavigation: (params) => params.navigation === 'caller',
  clientPlacement: (params) => params.placement?.kind === 'client',
  ownClientPage,
  unfocusedOwnClientPage: (params, caller) => params.focus !== true && ownClientPage(params, caller)
}

const HOST_WINDOW_REFUSED = new Set(classes.hostWindow.refused)
const HOST_WINDOW_NONE = new Set(classes.hostWindow.none)
const isCondition = (name: string): name is HostWindowCondition => name in HOST_WINDOW_CONDITIONS
const CONDITION_OF = new Map(
  Object.entries(classes.hostWindow.conditional).flatMap(([condition, methods]) =>
    isCondition(condition) ? methods.map((method) => [method, condition] as const) : []
  )
)

export function reachesHostWindow(
  methodName: string,
  rawParams: unknown,
  caller: HostWindowCaller
): boolean {
  const params = HostWindowParams.safeParse(rawParams).data ?? {}
  if (params.navigation && navigationTargetsHost(params.navigation)) {
    return true
  }
  if (HOST_WINDOW_NONE.has(methodName)) {
    return false
  }
  const condition = CONDITION_OF.get(methodName)
  // Refused, or not classified at all.
  return condition === undefined || HOST_WINDOW_REFUSED.has(methodName)
    ? true
    : !HOST_WINDOW_CONDITIONS[condition](params, caller)
}

// ── 4. Tabs ─────────────────────────────────────────────────────────────────────────────────────

/** A teammate, as their share device's scope names them. */
export type TabTeammate = { botId: string; accountId: string }
export type TeammateTabListKey = `teammate:${string}`
export type TabOwner = 'owner' | 'shared' | TeammateTabListKey

/** One tab list in a workspace: the host's (`holder` undefined) or a teammate's own. `holder` is read
 *  from the stamp on the terminal's or page's record, never chosen by a caller, and is required so
 *  no change can name a workspace alone. */
export type TabListRef = {
  readonly workspaceId: string
  readonly holder: TeammateTabListKey | undefined
}

export function teammateTabListKey(teammate: TabTeammate): TeammateTabListKey {
  // Encoded so no bot id and account id pair spells another's.
  return `teammate:${encodeURIComponent(teammate.botId)}:${encodeURIComponent(teammate.accountId)}`
}

/** The teammate a list key names (`teammateTabListKey`'s inverse). */
export function tabListTeammate(key: TeammateTabListKey): TabTeammate {
  const [, botId = '', accountId = ''] = key.split(':')
  return { botId: decodeURIComponent(botId), accountId: decodeURIComponent(accountId) }
}

export function isTeammateTabList(owner: string): owner is TeammateTabListKey {
  return owner.startsWith('teammate:')
}

/** The saved row of Homes whose older-build host tabs were moved to their teammates' lists. */
export const TEAMMATE_MOVED_HOMES_ROW = 'teammate-moves'

/** Whose tab list a caller reads and writes in a workspace; see rule 4. `teammate` is null for the
 *  host's window, the owner's devices, the CLI and anyone else who is not a share's teammate. */
export function tabOwnerOf(
  worktreeId: string,
  teammate: TabTeammate | null,
  bots: readonly Pick<Bot, 'id' | 'folderWorkspaceId'>[]
): TabOwner {
  const home = bots.find((bot) => folderWorkspaceKey(bot.folderWorkspaceId) === worktreeId)
  if (!home) {
    return 'shared'
  }
  return teammate && teammate.botId === home.id ? teammateTabListKey(teammate) : 'owner'
}

/** Who a Home tab write is for. It is always named by the writer, from one of two sources:
 *  - a user action: the caller's scope, read at the RPC handler (`callerTabPerson`);
 *  - a system write about a chat: the chat's stamp, whom it was created for
 *    (`chatTabPerson`, read from its acts-for record, which is written once when the chat starts).
 *  A host terminal's or the host's saved tabs are the owner's (`HOST_STATE_PERSON`). */
export type TabPerson = 'owner' | TeammateTabListKey

/** The writes the host's own state makes: its terminals, its saved tabs. */
export const HOST_STATE_PERSON: TabPerson = 'owner'

export function callerTabPerson(scope: RpcCallerScope | undefined): TabPerson {
  return scope?.kind === 'bot-share' ? teammateTabListKey(scope) : 'owner'
}

/** The list a person's write lands in: their own in their agent's Home, the host's (the owner's,
 *  or a worker workspace's one shared list) everywhere else. */
export function homeTabListOf(
  person: TabPerson,
  worktreeId: string,
  bots: readonly Pick<Bot, 'id' | 'folderWorkspaceId'>[]
): 'host' | TeammateTabListKey {
  if (person === 'owner') {
    return 'host'
  }
  const home = bots.find((bot) => folderWorkspaceKey(bot.folderWorkspaceId) === worktreeId)
  return home && person.startsWith(teammateTabListKey({ botId: home.id, accountId: '' }))
    ? person
    : 'host'
}

const HOME_TAB_HOST_LIST: ReadonlySet<string> = new Set(classes.homeTabs.hostList)

/** Rule 4: a call that writes the host's tab list of a workspace, refused in a teammate's own Home. */
export function writesHostTabList(methodName: string): boolean {
  return HOME_TAB_HOST_LIST.has(methodName)
}

/** A tab list read names: `'owner'` or a teammate by account. Absent, the caller's own (`tabOwnerOf`). */
export type TabListPerson = 'owner' | { accountId: string }

/** The list a read of `person`'s tabs names in a workspace: a teammate's own in the agent's Home, the
 *  host's for the owner and everywhere else (one shared list). */
export function viewedTabListOf(
  worktreeId: string,
  person: TabListPerson,
  bots: readonly Pick<Bot, 'id' | 'folderWorkspaceId'>[]
): 'host' | TeammateTabListKey {
  const home = bots.find((bot) => folderWorkspaceKey(bot.folderWorkspaceId) === worktreeId)
  return home && person !== 'owner'
    ? teammateTabListKey({ botId: home.id, accountId: person.accountId })
    : 'host'
}

// ── 6. Read marks ───────────────────────────────────────────────────────────────────────────────

/** Whether a caller's reads write, and read, the host's read marks: the owner's devices only. */
export function ownsHostReadMarks(scope: RpcCallerScope | undefined): boolean {
  return scope?.kind !== 'bot-share'
}

/** The client the host's unread verdicts go to: an owner's device reading its own list; a watched
 *  list goes as it is. */
export function unreadVerdictClient<K>(
  scope: RpcCallerScope | undefined,
  clientKind: K,
  watching: boolean
): K | undefined {
  return !watching && ownsHostReadMarks(scope) ? clientKind : undefined
}
