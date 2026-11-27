// Rule 4 for the host's window (teammate-rules.ts): its two entry points, the notifier and the
// renderer requests, ask `activeCallMayTouchHostTabs` for the workspace each call opens, focuses or
// drives a tab in. A teammate's call reaches the window only in a shared (worker) workspace.
import { browserManager } from '../../../browser/guest-lifecycle/manager/browser-manager'
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

/** Finds a tab's workspace in the host's lists, and a browser page's in the browser's. */
export function hostWindowLookups(
  hostLists: Iterable<[string, RuntimeMobileSessionTabsSnapshot]>
): Lookups {
  return {
    worktreeOfTab: (tabId) => {
      for (const [worktreeId, snapshot] of hostLists) {
        if (
          snapshot.tabs.some(
            (tab) => tab.id === tabId || ('parentTabId' in tab && tab.parentTabId === tabId)
          )
        ) {
          return worktreeId
        }
      }
      return null
    },
    worktreeOfBrowserPage: (browserPageId) =>
      browserManager.getWorktreeIdForTab(browserPageId) ?? null
  }
}
type Args<K extends keyof RuntimeNotifier> = Parameters<NonNullable<RuntimeNotifier[K]>>
type Target<K extends keyof RuntimeNotifier> = (args: Args<K>, lookups: Lookups) => string | null

const tab = (args: readonly unknown[], lookups: Lookups): string | null =>
  lookups.worktreeOfTab(args[0] as string)

// Every notifier method, typed so a new one cannot land unclassified: 'event' tells the window of a
// change and opens nothing; a function names the workspace whose tabs the call acts on.
const NOTIFIER_TARGETS: { [K in keyof RuntimeNotifier]-?: 'event' | Target<K> } = {
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
  activateWorktree: ([, worktreeId]) => worktreeId,
  createTerminal: ([worktreeId]) => worktreeId,
  revealTerminalSession: ([worktreeId]) => worktreeId,
  publishAgentLaunchTab: ([request]) => request.worktreeId,
  agentLaunchPaneVerdict: 'event',
  rememberLaunchRecipe: 'event',
  restartOffersChanged: 'event',
  resolveLegacyWorkerTerminalRecovery: 'event',
  splitTerminal: tab,
  renameTerminal: tab,
  setPaneTitle: tab,
  focusTerminal: ([, worktreeId]) => worktreeId,
  revealTerminalPane: ([target]) => target.worktreeId,
  focusEditorTab: ([, worktreeId]) => worktreeId,
  closeSessionTab: ([, worktreeId]) => worktreeId,
  moveSessionTab: ([worktreeId]) => worktreeId,
  movePaneToNewTab: ([move]) => move.worktreeId,
  openFile: ([worktreeId]) => worktreeId,
  revealEditorTab: ([reveal]) => reveal.worktreeId,
  openDiff: ([worktreeId]) => worktreeId,
  closeTerminal: tab,
  closeTerminalPane: tab,
  closeTerminalTab: tab,
  workspaceSleepChanged: 'event',
  sleepingMailChanged: 'event',
  resumeSleepingAgents: ([worktreeId]) => worktreeId,
  applyAgentPaneActivity: 'event',
  terminalFitOverrideChanged: 'event',
  terminalDriverChanged: 'event',
  nativeChatLaunchDraftResolved: tab,
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
  const guarded: Record<string, unknown> = { ...notifier }
  for (const [name, target] of Object.entries(NOTIFIER_TARGETS)) {
    const method = (notifier as Record<string, unknown>)[name]
    if (target === 'event' || typeof method !== 'function') {
      continue
    }
    guarded[name] = (...args: never[]) => {
      if (!admit((target as Target<keyof RuntimeNotifier>)(args as never, lookups))) {
        throw new TeammateHostTabWriteError(null, `host window ${name}`)
      }
      return method.apply(notifier, args)
    }
  }
  return guarded as RuntimeNotifier
}

// Every renderer request channel; one not listed is refused to a teammate.
const RENDERER_REQUEST_TARGETS: Record<
  string,
  (payload: Record<string, unknown>, lookups: Lookups) => string | null
> = {
  'terminal:requestTabCreate': (payload) => (payload.worktreeId as string | undefined) ?? null,
  'browser:requestTabCreate': (payload) => (payload.worktreeId as string | undefined) ?? null,
  'browser:requestTabClose': (payload) => (payload.worktreeId as string | undefined) ?? null,
  'browser:requestTabActivate': (payload, lookups) =>
    lookups.worktreeOfBrowserPage(payload.browserPageId as string),
  'browser:requestTabSetProfile': (payload, lookups) =>
    lookups.worktreeOfBrowserPage(payload.browserPageId as string)
}

export function rendererRequestAdmission(admit: HostWindowAdmission, lookups: Lookups) {
  return (request: RendererRequest): void => {
    const target = RENDERER_REQUEST_TARGETS[request.channel]
    const worktreeId = target ? target(request.payload as Record<string, unknown>, lookups) : null
    if (!admit(worktreeId)) {
      throw new TeammateHostTabWriteError(worktreeId, `host window ${request.channel}`)
    }
  }
}
