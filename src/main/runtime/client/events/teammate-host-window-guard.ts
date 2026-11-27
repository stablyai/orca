// Rule 4 for the host's window (teammate-rules.ts): its two entry points, the notifier and the
// renderer requests, ask `activeCallMayTouchHostTabs` for the workspace each call opens, focuses or
// drives a tab in. A teammate's call reaches the window only in a shared (worker) workspace.
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { z } from 'zod'
import { lazyZodSchema } from '../../../../shared/schema/lazy-zod-schema'
import type { RendererRequest } from '../../construction/runtime-desktop-surface'
import { TeammateHostTabWriteError } from '../../session-tabs/person/host-tab-list-admission'
import type { RuntimeNotifier } from './runtime-notifier-contract'

/** Answers whether the active call may act on the host window's tabs in a workspace (null: none named). */
export type HostWindowAdmission = (worktreeId: string | null) => boolean

type Lookups = {
  worktreeOfTab: (tabId: string) => string | null
  worktreeOfBrowserPage: (browserPageId: string) => string | null
}

/** Finds a tab's workspace, or a browser page's, in the host's lists. */
export function hostWindowLookups(
  hostLists: Iterable<[string, RuntimeMobileSessionTabsSnapshot]>
): Lookups {
  const find = (holds: (tab: RuntimeMobileSessionTabsSnapshot['tabs'][number]) => boolean) => {
    for (const [worktreeId, snapshot] of hostLists) {
      if (snapshot.tabs.some(holds)) {
        return worktreeId
      }
    }
    return null
  }
  return {
    worktreeOfTab: (tabId) =>
      find((tab) => tab.id === tabId || ('parentTabId' in tab && tab.parentTabId === tabId)),
    worktreeOfBrowserPage: (browserPageId) =>
      find((tab) => tab.type === 'browser' && tab.browserPageId === browserPageId)
  }
}

type Target = (args: readonly unknown[], lookups: Lookups) => string | null

const NamesWorktree = lazyZodSchema(() => z.looseObject({ worktreeId: z.string() }))
const NamesBrowserPage = lazyZodSchema(() => z.looseObject({ browserPageId: z.string() }))

/** The workspace named by argument `index`, or by that argument's `worktreeId`. */
const worktreeArg =
  (index: number): Target =>
  (args) => {
    const named = args[index]
    return typeof named === 'string'
      ? named
      : (NamesWorktree.safeParse(named).data?.worktreeId ?? null)
  }
const tabArg: Target = ([tabId], lookups) =>
  typeof tabId === 'string' ? lookups.worktreeOfTab(tabId) : null

const NOTIFIER_TARGETS: { [K in keyof RuntimeNotifier]-?: 'event' | Target } = {
  automationsChanged: 'event',
  worktreesChanged: 'event',
  workspaceMetadataSet: 'event',
  worktreeBaseStatus: 'event',
  worktreeRemoteBranchConflict: 'event',
  reposChanged: 'event',
  browserProfilesChanged: 'event',
  botsChanged: 'event',
  orchestrationSessionWorkersChanged: 'event',
  peerMailReturned: 'event',
  mcpServersChanged: 'event',
  workspaceCleanupRunFinished: 'event',
  activateWorktree: worktreeArg(1),
  createTerminal: worktreeArg(0),
  revealTerminalSession: worktreeArg(0),
  publishAgentLaunchTab: worktreeArg(0),
  agentLaunchPaneVerdict: 'event',
  rememberLaunchRecipe: 'event',
  restartOffersChanged: 'event',
  resolveLegacyWorkerTerminalRecovery: 'event',
  splitTerminal: tabArg,
  renameTerminal: tabArg,
  setPaneTitle: tabArg,
  focusTerminal: worktreeArg(1),
  revealTerminalPane: worktreeArg(0),
  focusEditorTab: worktreeArg(1),
  closeSessionTab: worktreeArg(1),
  moveSessionTab: worktreeArg(0),
  movePaneToNewTab: worktreeArg(0),
  openFile: worktreeArg(0),
  revealEditorTab: worktreeArg(0),
  openDiff: worktreeArg(0),
  closeTerminal: tabArg,
  closeTerminalPane: tabArg,
  closeTerminalTab: tabArg,
  workspaceSleepChanged: 'event',
  sleepingMailChanged: 'event',
  resumeSleepingAgents: worktreeArg(0),
  applyAgentPaneActivity: 'event',
  terminalFitOverrideChanged: 'event',
  terminalDriverChanged: 'event',
  nativeChatLaunchDraftResolved: tabArg,
  browserDriverChanged: 'event',
  browserRemoteViewersChanged: 'event',
  clientHostedBrowserRowsChanged: 'event',
  claudeAccountSelected: 'event'
}

const NOTIFIER_METHOD_TARGETS = new Map<string, 'event' | Target>(Object.entries(NOTIFIER_TARGETS))

/** True for every notifier method: NOTIFIER_TARGETS names each, by its type. */
function isNotifierMethod(name: string | symbol): name is keyof RuntimeNotifier {
  return typeof name === 'string' && NOTIFIER_METHOD_TARGETS.has(name)
}

/** The notifier as the runtime holds it: a call a teammate may not make throws before the window sees it. */
export function guardNotifierForTeammates(
  notifier: RuntimeNotifier,
  admit: HostWindowAdmission,
  lookups: Lookups
): RuntimeNotifier {
  return new Proxy(notifier, {
    get(held, name) {
      if (!isNotifierMethod(name)) {
        return undefined
      }
      const method = held[name]
      const target = NOTIFIER_METHOD_TARGETS.get(name)
      if (!target || target === 'event' || typeof method !== 'function') {
        return method
      }
      return (...args: unknown[]): unknown => {
        if (!admit(target(args, lookups))) {
          throw new TeammateHostTabWriteError(null, `host window ${name}`)
        }
        return Function.prototype.apply.call(method, held, args)
      }
    }
  })
}

// Every renderer request channel; one not listed is refused to a teammate.
const browserPage: Target = ([payload], lookups) => {
  const browserPageId = NamesBrowserPage.safeParse(payload).data?.browserPageId
  return browserPageId ? lookups.worktreeOfBrowserPage(browserPageId) : null
}
const RENDERER_REQUEST_TARGETS = new Map<string, Target>([
  ['terminal:requestTabCreate', worktreeArg(0)],
  ['browser:requestTabCreate', worktreeArg(0)],
  ['browser:requestTabClose', worktreeArg(0)],
  ['browser:requestTabActivate', browserPage],
  ['browser:requestTabSetProfile', browserPage]
])

export function rendererRequestAdmission(admit: HostWindowAdmission, lookups: Lookups) {
  return (request: RendererRequest): void => {
    const worktreeId =
      RENDERER_REQUEST_TARGETS.get(request.channel)?.([request.payload], lookups) ?? null
    if (!admit(worktreeId)) {
      throw new TeammateHostTabWriteError(worktreeId, `host window ${request.channel}`)
    }
  }
}
