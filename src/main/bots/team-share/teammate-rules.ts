// What a teammate (a caller whose scope is a share, `callerScope.kind === 'bot-share'`) reaches on the
// host, as one rule list. Each rule is decided once, from the caller scope stamped at admission
// (`botShareCallerScopeOf`); handlers and the tab store get the answer, never re-check the caller.
//
//  1. Methods. A teammate calls only what teammate-method-classes.json admits: the workspace tier by
//     its class (`scoped` | `filtered` | `own`; unlisted is `refused`), a chats-only teammate by each
//     method's `share` rule. `teammateMethodClass`.
//  2. Workspaces. Every list and stream a teammate reads is kept to the shared agent's workspaces (its
//     Home and its workers' worktrees): `filtered` methods, through `withTeammateLists` or their
//     handlers (`TEAMMATE_HANDLER_FILTERED`, teammate-workspace-view.ts).
//  3. Host window. Nothing a teammate calls opens, focuses or drives the host's own window:
//     `reachesHostWindow`, by each reachable method's `hostWindow` class.
//  4. Tabs. Each person on the host has their own tab list in the agent's Home; every other workspace
//     has one list, shared by everyone who can reach it. `tabOwnerOf` names the list, and the tab store
//     reads and writes only that list:
//       - 'owner': the agent's Home, for the host's window and the owner's devices;
//       - `teammate:<botId>:<accountId>`: that bot's Home, for that teammate's devices;
//       - 'shared': every other workspace, for anyone (worker workspaces stay one list).
//     A teammate's Home list holds chats. A call that would open, move or reshape a tab of the host's
//     list in the teammate's own Home (`homeTabs.hostList`) is refused there; every session.tabs read,
//     stream, activate and close (`homeTabs.person`), and every chat tab write (reveal, create, Fork,
//     restore, publish), goes to the list `tabOwnerOf` names. `homeTabs.none` touch no list.
//     `TEAMMATE_TAB_WRITES` classifies every host tab writer.
//  5. Name and asker. A teammate is named by their share row's `name`, and every chat or turn they start
//     acts for them (`botShareAsker`).
import classes from '../../runtime/rpc/callers/teammate-method-classes.json'
import { z } from 'zod'
import {
  navigationTargetsHost,
  RUNTIME_NAVIGATION_TARGETS
} from '../../../shared/remote-runtime/session-graph/runtime-navigation'
import type { Bot } from '../../../shared/bot-types'
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

export function teammateTabListKey(teammate: TabTeammate): TeammateTabListKey {
  // Encoded so no bot id and account id pair spells another's.
  return `teammate:${encodeURIComponent(teammate.botId)}:${encodeURIComponent(teammate.accountId)}`
}

export function isTeammateTabList(owner: string): owner is TeammateTabListKey {
  return owner.startsWith('teammate:')
}

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

const HOME_TAB_HOST_LIST: ReadonlySet<string> = new Set(classes.homeTabs.hostList)

/** Rule 4: a call that writes the host's tab list of a workspace, refused in a teammate's own Home. */
export function writesHostTabList(methodName: string): boolean {
  return HOME_TAB_HOST_LIST.has(methodName)
}

/** Every host tab writer (each file that writes `mobileSessionTabsByWorktree` or publishes a chat tab),
 *  and how a teammate's write stays off another person's list:
 *  - 'routed': it asks `tabOwnerOf`, so a teammate's chat in their Home lands in their own list;
 *  - 'host-list': it writes the host's list only, which a teammate reaches in their Home only through
 *    `homeTabs.hostList` methods (refused there), or never (the host's window, restart, the owner).
 *  The census test fails on a writer missing here. */
export const TEAMMATE_TAB_WRITES: Readonly<Record<string, 'routed' | 'host-list'>> = {
  'src/main/bots/bot-session-tab-show.ts': 'routed',
  'src/main/runtime/construction/runtime-identity-state.ts': 'host-list',
  'src/main/runtime/construction/runtime-service-state.ts': 'host-list',
  'src/main/runtime/orchestration/terminal-authority/legacy-worker-terminal-surface.ts':
    'host-list',
  'src/main/runtime/rpc/methods/structured-sessions/conversation/structured-agent-session-reveal.ts':
    'routed',
  'src/main/runtime/rpc/methods/structured-sessions/creation/structured-agent-session-create.ts':
    'routed',
  'src/main/runtime/session-graph/session-window-graph.ts': 'host-list',
  'src/main/runtime/session-graph/session-window-publisher.ts': 'host-list',
  'src/main/runtime/session-lifecycle/close/close-mobile-row-in-main-layout.ts': 'host-list',
  'src/main/runtime/session-lifecycle/projection/apply-mobile-session-tab-navigation.ts':
    'host-list',
  'src/main/runtime/session-lifecycle/projection/build-headless-mobile-session-browser-tabs.ts':
    'host-list',
  'src/main/runtime/session-lifecycle/projection/prune-mobile-session-tab-group-layout.ts':
    'host-list',
  'src/main/runtime/session-lifecycle/projection/reconcile-headless-mobile-session-browser-tabs.ts':
    'host-list',
  'src/main/runtime/session-lifecycle/projection/restart-agent-pane-in-place.ts': 'host-list',
  'src/main/runtime/session-tabs/chat/background-chat-tab-publication.ts': 'routed',
  'src/main/runtime/session-tabs/chat/restored-chat-tab-changes.ts': 'host-list',
  'src/main/runtime/session-tabs/chat/saved-conversation-title-publication.ts': 'host-list',
  'src/main/runtime/session-tabs/chat/structured-session-tab-close.ts': 'host-list',
  'src/main/runtime/session-tabs/chat/structured-session-tab-publication.ts': 'host-list',
  'src/main/runtime/session-tabs/chat/structured-session-tab-restoration.ts': 'routed',
  'src/main/runtime/session-tabs/inventory/session-tabs-inventory.ts': 'host-list',
  'src/main/runtime/session-tabs/layout/headless-pane-move-to-new-tab.ts': 'host-list',
  'src/main/runtime/session-tabs/layout/headless-tab-group-moves.ts': 'host-list',
  'src/main/runtime/session-tabs/layout/headless-tab-properties.ts': 'host-list',
  'src/main/runtime/session-tabs/layout/main-layout-session-tab-move.ts': 'host-list',
  'src/main/runtime/session-tabs/publication/pty-backed-session-publication.ts': 'host-list',
  'src/main/runtime/session-tabs/restoration/headless-editor-tabs.ts': 'host-list',
  'src/main/runtime/session-tabs/restoration/mobile-session-hydration.ts': 'host-list',
  'src/main/runtime/session-tabs/restoration/mobile-session-membership.ts': 'host-list',
  'src/main/runtime/session-tabs/restoration/mobile-session-reconciliation.ts': 'host-list',
  'src/main/runtime/session-tabs/restoration/renderer-session-terminal-rescue.ts': 'host-list',
  'src/main/runtime/session-tabs/terminal-retirement/headless-terminal-tab-close.ts': 'host-list',
  'src/main/runtime/session-tabs/terminal-retirement/terminal-surface-retirements.ts': 'host-list',
  'src/main/runtime/terminal/launch/mobile-terminal-owned-create.ts': 'host-list'
}
