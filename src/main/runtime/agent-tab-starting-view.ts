import {
  canMirrorLaunchDraftToNativeChat,
  finalizeAgentTabStartingView
} from '../../shared/native-chat-starting-view'
import { isNativeChatTranscriptLocalReadable } from '../../shared/native-chat-transcript-readability'
import type { TerminalChatPair, TerminalTabViewMode } from '../../shared/terminal-tab-view-mode'
import type { TuiAgent } from '../../shared/tui-agent'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import { readHeadlessChatPairState } from './session-tab-chat-pair'

type StartingViewLaunch = {
  launchAgent?: TuiAgent
  viewMode?: TerminalTabViewMode
  launcherDefaultView?: TerminalTabViewMode
}

/**
 * The host's finalization of a new agent tab's starting view: a decided `viewMode`, else the
 * launching device's default, else this host's, gated by what chat can show on this workspace's
 * route. A launch with no recognized agent keeps whatever the caller sent.
 */
export function withFinalAgentTabStartingView<T extends StartingViewLaunch>(
  launch: T,
  workspace: { connectionId: string | null },
  settings: { experimentalNativeChat?: boolean; openAgentTabsInChatByDefault?: boolean } | null
): T & Pick<StartingViewLaunch, 'viewMode'> {
  if (!launch.launchAgent) {
    return launch
  }
  const viewMode = finalizeAgentTabStartingView({
    viewMode: launch.viewMode,
    launcherDefaultView: launch.launcherDefaultView,
    settings,
    agent: launch.launchAgent,
    nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(workspace.connectionId)
  })
  return viewMode === launch.viewMode ? launch : { ...launch, viewMode }
}

/** What a launch's tab committed, and whether this launch's admission created that record. */
export type CommittedAgentTabStartingView = {
  pair: TerminalChatPair
  /** Proof of THIS fresh launch: only then may a reused renderer tab fill in a missing view. */
  freshLaunch: boolean
}

/**
 * The starting view a launch publishes and reveals: the persisted record's pair (absence
 * included), never the raw request. Without a persisted row only a fresh launch may use its own.
 */
export function readCommittedAgentTabStartingView(args: {
  session: WorkspaceSessionState | null | undefined
  worktreeId: string
  tabId: string
  leafId: string
  requested: TerminalTabViewMode | undefined
  freshLaunch: boolean
}): CommittedAgentTabStartingView {
  const committed = readHeadlessChatPairState(args.session, undefined, args.worktreeId, args.tabId)
  if (committed) {
    return { pair: committed.pair, freshLaunch: args.freshLaunch }
  }
  if (!args.freshLaunch || !args.requested) {
    return { pair: {}, freshLaunch: args.freshLaunch }
  }
  return {
    pair: {
      viewMode: args.requested,
      ...(args.requested === 'chat' ? { chatLeafId: args.leafId } : {})
    },
    freshLaunch: true
  }
}

export type AgentTabStartingViewProbe = {
  /** After admission: the committed view as publication and reveal fields. */
  read: (
    tabId: string,
    leafId: string,
    requested: TerminalTabViewMode | undefined,
    adopted: boolean
  ) => {
    publish: { viewMode?: TerminalTabViewMode; chatLeafId?: string }
    reveal: { viewMode?: TerminalTabViewMode; freshLaunchView?: true }
  }
}

/**
 * Taken before a launch's spawn. A tab with no record yet can only be created by this launch, so
 * that (and no adoption or owner swap since) is the proof a reused renderer tab may fill in.
 */
export function probeAgentTabStartingView(
  readSession: () => WorkspaceSessionState | null | undefined,
  worktreeId: string,
  requestedTabId: string
): AgentTabStartingViewProbe {
  const recordedBefore = hasPersistedTerminalTabRow(readSession(), worktreeId, requestedTabId)
  return {
    read: (tabId, leafId, requested, adopted) => {
      const { pair, freshLaunch } = readCommittedAgentTabStartingView({
        session: readSession(),
        worktreeId,
        tabId,
        leafId,
        requested,
        freshLaunch: !adopted && !recordedBefore && tabId === requestedTabId
      })
      return {
        publish: {
          ...(pair.viewMode ? { viewMode: pair.viewMode } : {}),
          ...(pair.chatLeafId ? { chatLeafId: pair.chatLeafId } : {})
        },
        reveal: {
          ...(pair.viewMode ? { viewMode: pair.viewMode } : {}),
          ...(freshLaunch && pair.viewMode ? { freshLaunchView: true as const } : {})
        }
      }
    }
  }
}

export function hasPersistedTerminalTabRow(
  session: WorkspaceSessionState | null | undefined,
  worktreeId: string,
  tabId: string
): boolean {
  return session?.tabsByWorktree?.[worktreeId]?.some((tab) => tab.id === tabId) === true
}

/**
 * A worktree's startup launch carrying the launcher's view inputs to `createTerminal`, which
 * finalizes them. An unsent draft chat cannot mirror pins terminal, the same gate as the composer.
 */
export function withWorktreeStartupView(
  args: {
    startup?: WorktreeStartupLaunch
    startupViewMode?: TerminalTabViewMode
    launcherDefaultView?: TerminalTabViewMode
    startupDraft?: string
    startupDraftPaste?: { content: string }
  },
  agentStartup: { startup: WorktreeStartupLaunch } | null,
  draftStartup: { startup: WorktreeStartupLaunch } | null
): WorktreeStartupLaunch | undefined {
  const startup = args.startup ?? agentStartup?.startup ?? draftStartup?.startup
  if (!startup) {
    return startup
  }
  const draftText =
    args.startupDraftPaste?.content ?? (draftStartup ? args.startupDraft : undefined)
  const viewMode =
    draftText?.trim() && !canMirrorLaunchDraftToNativeChat(draftText)
      ? 'terminal'
      : (startup.viewMode ?? args.startupViewMode)
  const launcherDefaultView = startup.launcherDefaultView ?? args.launcherDefaultView
  return viewMode === startup.viewMode && launcherDefaultView === startup.launcherDefaultView
    ? startup
    : {
        ...startup,
        ...(viewMode ? { viewMode } : {}),
        ...(launcherDefaultView ? { launcherDefaultView } : {})
      }
}
