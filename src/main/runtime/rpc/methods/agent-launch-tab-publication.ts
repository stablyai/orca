/**
 * The tab of an `agent.launch`, shown before the launch is admitted.
 *
 * Admission, workspace resolution, the mode decision and the daemon spawn each have a cold cost (a
 * Windows window still booting its first PowerShell measured ~0.55 s and ~1 s), and the tab used to
 * wait for all of them. It now waits for none: the host asks the window for the tab first, under ids
 * the spawn will bake into the agent's PTY, and the pane attaches to that process when it exists.
 *
 * Only a launch with an operation id gets one: the launch record is what tells the pane, then and
 * after a restart, which launch owns it and how it ended (`agent-launch-pane-attachment`).
 *
 * Best-effort by construction. Anything this cannot decide cheaply — a workspace it cannot resolve,
 * a chat-mode default, no window owning the layout, a pane already running something — skips the
 * early tab, and the launch's tab appears when it spawns, exactly as before.
 */

import { randomUUID } from 'node:crypto'
import type {
  AgentLaunchPlacementReceipt,
  AgentLaunchResult
} from '../../../../shared/agent-launch-intent'
import { AGENT_LAUNCH_UNSTARTED_TAB_CLIENT_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import type {
  AgentLaunchTabPublished,
  AgentLaunchTabViewerRule
} from '../../../../shared/agent-launch-tab-publication'
import {
  listAgentSessionOperationRowsOwningPane,
  type AgentSessionOperationOwnedPane
} from '../../../../shared/agent-session-operation-ledger'
import {
  navigationTargetsHost,
  resolveRuntimeNavigationTarget
} from '../../../../shared/runtime-navigation'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { workspaceKindForWorktreeId } from '../../../../shared/workspace-launch-kind'
import {
  agentLaunchPaneVerdictFromRecord,
  trackRunningAgentLaunchPane
} from '../../../agent-launch/agent-launch-pane-attachment'
import type { AgentLaunchPaneVerdict } from '../../../../shared/agent-launch-pane-verdict'
import {
  decideAgentLaunchMode,
  readAgentLaunchModeSettings
} from '../../../agent-launch/agent-launch-mode'
import { deriveAgentLaunchTerminalViewMode } from '../../../agent-launch/agent-launch-view-mode'
import type { RpcContext } from '../core'
import type { AgentLaunchParams } from './agent-launch-schemas'
import { agentLaunchOperationCallerKey } from './agent-launch-replay'

/** Whether a launch may move the host window at all: a paired device's launch moves only its own
 *  view, as its browser tabs do. The tab shown first and the spawn's own reveal both ask this. */
export function agentLaunchMovesHostWindow(
  context: Pick<RpcContext, 'caller' | 'clientKind'>
): boolean {
  return (
    context.caller?.kind === 'desktop' ||
    navigationTargetsHost(resolveRuntimeNavigationTarget({ clientKind: context.clientKind }))
  )
}

/**
 * Whose screen moves. `presentation` is `terminal.create`'s field with its meaning (focused: the
 * host selects the tab; background: nothing moves). The desktop's own view is the host window,
 * which follows only while it still shows that workspace. A paired device's launch leaves the host
 * window where it is; the device selects the tab for itself.
 */
export function agentLaunchTabViewerRule(
  context: Pick<RpcContext, 'caller' | 'clientKind'>,
  presentation: AgentLaunchParams['presentation']
): AgentLaunchTabViewerRule {
  if (presentation === 'background' || !agentLaunchMovesHostWindow(context)) {
    return 'none'
  }
  if (context.caller?.kind === 'desktop') {
    return 'focus-in-workspace'
  }
  return presentation === 'focused' ? 'focus-window' : 'reveal-owner'
}

/**
 * A paired caller that does not advertise the capability reads "my reserved tab is listed" as proof
 * its agent started; a tab listed before the spawn would make a lost reply read as a started agent.
 */
function readsEarlyLaunchTab(context: Pick<RpcContext, 'caller' | 'clientCapabilities'>): boolean {
  return (
    context.caller?.kind !== 'paired-device' ||
    context.clientCapabilities?.includes(AGENT_LAUNCH_UNSTARTED_TAB_CLIENT_CAPABILITY) === true
  )
}

export type EarlyAgentLaunchTab = {
  /** The pane the launch must create: the caller's, or one minted here. */
  paneKey: string
  /** What the launch record names as this launch's pane. */
  ownedPane: AgentSessionOperationOwnedPane
  /** Admission let this request run, so the record now names the pane and tells it how it ended. */
  executing(): void
  /** The surface exists; an agent in this pane lets the pane's waiting spawn attach to it now. */
  surfacePublished(result: AgentLaunchResult): void
  /** The window has said it shows the tab, so the spawn must bind it without a second reveal. */
  windowShowsTab(): boolean
  /** The user closed the tab or pane: the launch must not start its agent, or must stop it. */
  closedByUser(): boolean
  /** The launch is over, however it ended. A tab this request made goes when nothing will ever run
   *  in it: never admitted, or its surface landed elsewhere. A failed launch's tab stays to say why. */
  finish(): void
  /** Where the window placed the tab, once it has said. */
  placement(): AgentLaunchPlacementReceipt | undefined
}

/** The view half of a launch: the tab shown before it ran, and whether the caller's view moves. */
export type AgentLaunchView = {
  early: EarlyAgentLaunchTab | null
  presentation: AgentLaunchParams['presentation']
}

export function withPlacement(result: AgentLaunchResult, view: AgentLaunchView): AgentLaunchResult {
  const placement = view.early?.placement()
  return placement ? { ...result, placement } : result
}

/** The record already holds this operation: whatever it answers (a replay, a conflict, a recorded
 *  failure), nothing new runs, so no tab is shown for it and no one moves. */
function isRecordedOperation(params: AgentLaunchParams, context: RpcContext): boolean {
  if (!params.operationId || !context.caller) {
    return false
  }
  const store = context.runtime.openedAgentSessionRecordStore()
  return (
    store !== null &&
    store.getOperationRow(agentLaunchOperationCallerKey(context), params.operationId) !== null
  )
}

/** Never throws: the early tab is a view, and a launch must not fail over one. */
export function publishEarlyTab(
  params: AgentLaunchParams,
  context: RpcContext
): Promise<EarlyAgentLaunchTab | null> {
  if (isRecordedOperation(params, context)) {
    return Promise.resolve(null)
  }
  return publishAgentLaunchTabEarly(params, context).catch((error: unknown) => {
    console.warn('[agent-launch] could not show the launch tab early', error)
    return null
  })
}

export async function publishAgentLaunchTabEarly(
  params: AgentLaunchParams,
  context: RpcContext
): Promise<EarlyAgentLaunchTab | null> {
  const runtime = context.runtime
  if (
    params.target.kind !== 'existing' ||
    params.reuseTerminal ||
    !readsEarlyLaunchTab(context) ||
    !runtime.canPublishAgentLaunchTab() ||
    // A running pane is attached to, never launched into; this launch is refused and must not
    // touch the pane another launch's agent is running in.
    (params.paneKey !== undefined && runtime.hasLiveTerminalForPaneKey(params.paneKey))
  ) {
    return null
  }
  let workspace: Awaited<ReturnType<typeof runtime.showTerminalWorkspaceLaunchScope>>
  try {
    workspace = await runtime.showTerminalWorkspaceLaunchScope(params.target.worktree)
  } catch {
    // The launch resolves it again after admission and answers for it there.
    return null
  }
  const settings = readAgentLaunchModeSettings(runtime)
  const preflight = decideAgentLaunchMode({
    placement: {
      agent: params.agent,
      workspaceKind: workspaceKindForWorktreeId(workspace.id),
      workspacePath: workspace.path,
      ...(params.cwd ? { cwd: params.cwd } : {})
    },
    settings
  })
  // A chat's tab is the session's; it appears when the session is created.
  if (preflight.mode !== 'terminal') {
    return null
  }
  const paneKey = params.paneKey ?? makePaneKey(randomUUID(), randomUUID())
  const pane = parsePaneKey(paneKey)
  if (!pane) {
    return null
  }
  const ownedPane = { worktreeId: workspace.id, paneKey }
  // Before the window hears of the tab, so a pane that mounts at once already waits.
  const running = trackRunningAgentLaunchPane(ownedPane)
  let publishing: ReturnType<typeof runtime.publishAgentLaunchTab>
  try {
    publishing = runtime.publishAgentLaunchTab({
      worktreeId: workspace.id,
      tabId: pane.tabId,
      leafId: pane.leafId,
      launchAgent: params.agent,
      viewMode: deriveAgentLaunchTerminalViewMode({
        settings,
        agent: params.agent,
        ...(params.prompt ? { prompt: params.prompt } : {}),
        connectionId: workspace.connectionId
      }),
      ...(params.placement ? { placement: params.placement } : {}),
      viewer: agentLaunchTabViewerRule(context, params.presentation),
      ...(params.prompt?.text ? { prompt: params.prompt.text } : {}),
      ...(params.operationId ? { operationId: params.operationId } : {})
    })
  } catch (error) {
    running.finish({ tabTakenBack: false })
    throw error
  }
  if (!publishing) {
    running.finish({ tabTakenBack: false })
    return null
  }
  return trackEarlyAgentLaunchTab({
    paneKey,
    ownedPane,
    publishing,
    finishRunning: (tabTakenBack) => running.finish({ tabTakenBack }),
    agentBound: () => running.agentBound(),
    paneIsLive: () => runtime.hasLiveTerminalForPaneKey(paneKey),
    closedByUser: () => running.closedByUser(),
    report: (verdict) =>
      runtime.reportAgentLaunchPaneVerdict(
        { worktreeId: workspace.id, tabId: pane.tabId, leafId: pane.leafId },
        verdict
      ),
    // What the record now says for a pane nothing spawned into, so it never stays blank.
    unspawnedVerdict: () =>
      runtime.hasLiveTerminalForPaneKey(paneKey)
        ? { kind: 'proceed' }
        : agentLaunchPaneVerdictFromRecord(
            listAgentSessionOperationRowsOwningPane(
              runtime.openedAgentSessionRecordStore()?.listOperationRows() ?? [],
              ownedPane,
              Date.now()
            ),
            paneKey
          )
  })
}

function trackEarlyAgentLaunchTab(args: {
  paneKey: string
  ownedPane: AgentSessionOperationOwnedPane
  publishing: Promise<AgentLaunchTabPublished>
  finishRunning: (tabTakenBack: boolean) => void
  agentBound: () => void
  paneIsLive: () => boolean
  closedByUser: () => boolean
  report: (verdict: AgentLaunchPaneVerdict) => void
  unspawnedVerdict: () => AgentLaunchPaneVerdict
}): EarlyAgentLaunchTab {
  let reply: AgentLaunchTabPublished | null = null
  let executing = false
  let ranHere: boolean | null = null
  const published = args.publishing.then(
    (answer) => {
      reply = answer
      return answer
    },
    (error: unknown) => {
      // The tab did not appear; the launch still runs and its tab appears when it spawns.
      console.warn('[agent-launch] the window did not show the launch tab early', error)
      return null
    }
  )
  return {
    paneKey: args.paneKey,
    ownedPane: args.ownedPane,
    executing: () => {
      executing = true
    },
    surfacePublished: (result) => {
      ranHere = result.outcome.kind === 'terminal' && result.outcome.paneKey === args.paneKey
      if (ranHere) {
        // Before its prompt is delivered, which can take a minute: the pane shows the agent now.
        args.agentBound()
      }
    },
    windowShowsTab: () => reply !== null,
    closedByUser: args.closedByUser,
    finish: () => {
      if (ranHere === true) {
        // The agent's spawn bound the pane; its own spawn settles the tab.
        args.finishRunning(false)
        return
      }
      void published.then((answer) => {
        // Only a tab this request made goes, only when nothing will ever run in it, and never one
        // a running agent holds (a replay can remake a tab whose agent survived).
        const nothingWillRunHere = !executing || ranHere === false
        const takeBack = answer?.created === true && nothingWillRunHere && !args.paneIsLive()
        args.finishRunning(takeBack)
        // Every shown pane nothing spawned into ends in a verdict: taken back, or what the record says.
        args.report(takeBack ? { kind: 'withdrawn' } : args.unspawnedVerdict())
      })
    },
    placement: () => reply?.placement
  }
}
