// Rule 4 for the host's window (teammate-rules.ts): its two entry points, the notifier and the
// renderer requests, ask `activeCallMayTouchHostTabs` for the workspace each call opens, focuses or
// drives a tab in. A teammate's call reaches the window only in a shared (worker) workspace.
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
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

function stringField(value: unknown, key: string): string | null {
  const field: unknown =
    typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
  return typeof field === 'string' ? field : null
}
/** The workspace named by argument `index`, or by that argument's `worktreeId`. */
const worktreeArg =
  (index: number): Target =>
  (args) =>
    typeof args[index] === 'string' ? args[index] : stringField(args[index], 'worktreeId')
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

/** The notifier as the runtime holds it: a call a teammate may not make throws before the window sees it. */
export function guardNotifierForTeammates(
  notifier: RuntimeNotifier,
  admit: HostWindowAdmission,
  lookups: Lookups
): RuntimeNotifier {
  const targets = new Map<string, 'event' | Target>(Object.entries(NOTIFIER_TARGETS))
  return new Proxy(notifier, {
    get(held, name, receiver) {
      const method: unknown = Reflect.get(held, name, receiver)
      const target = typeof name === 'string' ? targets.get(name) : undefined
      if (!target || target === 'event' || typeof method !== 'function') {
        return method
      }
      return (...args: unknown[]): unknown => {
        if (!admit(target(args, lookups))) {
          throw new TeammateHostTabWriteError(null, `host window ${String(name)}`)
        }
        return Reflect.apply(method, held, args)
      }
    }
  })
}

// Every renderer request channel; one not listed is refused to a teammate.
const browserPage: Target = ([payload], lookups) => {
  const browserPageId = stringField(payload, 'browserPageId')
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
