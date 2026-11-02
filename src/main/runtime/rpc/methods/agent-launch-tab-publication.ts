/** Publish a stable-id tab before cold admission/spawn for replay-safe launches; its pane waits for the launch.
 * Best-effort only: unresolved workspace, chat default, absent layout owner or occupied pane falls back to publication at spawn.
 * After restart the pane behaves as an ordinary pane. */

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
  navigationTargetsHost,
  resolveRuntimeNavigationTarget
} from '../../../../shared/runtime-navigation'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { workspaceKindForWorktreeId } from '../../../../shared/workspace-launch-kind'
import { trackRunningAgentLaunchPane } from '../../../agent-launch/agent-launch-pane-attachment'
import type { AgentLaunchPaneVerdict } from '../../../../shared/agent-launch-pane-verdict'
import {
  decideAgentLaunchMode,
  readAgentLaunchModeSettings
} from '../../../agent-launch/agent-launch-mode'
import type { RpcContext } from '../core'
import type { AgentLaunchParams } from '../../../../shared/rpc-contract/agent-launch-params'
import { agentLaunchOperationCallerKey } from './agent-launch-replay'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

/** Paired launches move only the caller's view; both early publication and spawn must obey this. */
export function agentLaunchMovesHostWindow(
  context: Pick<RpcContext, 'caller' | 'clientKind'>
): boolean {
  return (
    context.caller?.kind === 'desktop' ||
    navigationTargetsHost(resolveRuntimeNavigationTarget({ clientKind: context.clientKind }))
  )
}

/** Focused selects the host tab only while it shows this workspace; background moves nothing. Paired devices select their own view. */
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

/** Older paired callers treat a listed reserved tab as proof of spawn; require capability before publishing early. */
function readsEarlyLaunchTab(context: Pick<RpcContext, 'caller' | 'clientCapabilities'>): boolean {
  return (
    context.caller?.kind !== 'paired-device' ||
    context.clientCapabilities?.includes(AGENT_LAUNCH_UNSTARTED_TAB_CLIENT_CAPABILITY) === true
  )
}

export type EarlyAgentLaunchTab = {
  /** The pane the launch must create: the caller's, or one minted here. */
  paneKey: string
  /** Admission let this request run. */
  executing(): void
  /** The surface exists; an agent in this pane lets the pane's waiting spawn attach to it now. */
  surfacePublished(result: AgentLaunchResult): void
  /** Pending or completed publication owns selection; a failed publication leaves it to spawn. */
  windowOwnsPresentation(): boolean
  /** The user closed the tab or pane: the launch must not start its agent, or must stop it. */
  closedByUser(): boolean
  /** Finish with definite failureCode or null for uncertainty; remove only newly created tabs that will never run anything, keeping failed tabs to explain why. */
  finish(failureCode?: string | null): void
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

/** Recorded operations must replay/refuse without showing another tab or moving anyone's view. */
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
    // An explicit chat's tab is the session's; a refusal is answered after admission, not here.
    params.surface === 'chat' ||
    !readsEarlyLaunchTab(context) ||
    // Switch point: main writes the tab of a workspace it owns itself, window or not.
    !(ORCA_LAYOUT_OWNER_IS_MAIN || runtime.canPublishAgentLaunchTab()) ||
    // Never touch an occupied reserved pane; attaching would run this launch into another agent.
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
  const settings = readAgentLaunchModeSettings(runtime, params)
  const preflight = decideAgentLaunchMode({
    placement: {
      agent: params.agent,
      workspaceKind: workspaceKindForWorktreeId(workspace.id),
      workspacePath: workspace.path,
      ...(params.cwd ? { cwd: params.cwd } : {})
    },
    settings,
    ...(params.surface ? { surface: params.surface } : {})
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
  // Before the window hears of the tab, so a pane that mounts at once already waits.
  const running = trackRunningAgentLaunchPane({ worktreeId: workspace.id, paneKey })
  let publishing: ReturnType<typeof runtime.publishAgentLaunchTab>
  try {
    const request = {
      worktreeId: workspace.id,
      tabId: pane.tabId,
      leafId: pane.leafId,
      launchAgent: params.agent,
      viewMode: 'terminal' as const,
      ...(params.placement ? { placement: params.placement } : {}),
      viewer: agentLaunchTabViewerRule(context, params.presentation),
      ...(params.prompt?.text ? { prompt: params.prompt.text } : {}),
      ...(params.operationId ? { operationId: params.operationId } : {})
    }
    // Switch point: a workspace main owns gets its tab in main's layout; any other, the window's.
    publishing =
      (ORCA_LAYOUT_OWNER_IS_MAIN ? runtime.publishAgentLaunchTabInMainLayout(request) : null) ??
      runtime.publishAgentLaunchTab(request)
  } catch (error) {
    running.finish({ kind: 'proceed' })
    throw error
  }
  if (!publishing) {
    running.finish({ kind: 'proceed' })
    return null
  }
  return trackEarlyAgentLaunchTab({
    paneKey,
    publishing,
    finishRunning: (verdict) => running.finish(verdict),
    agentBound: () => running.agentBound(),
    paneIsLive: () => runtime.hasLiveTerminalForPaneKey(paneKey),
    closedByUser: () => running.closedByUser(),
    report: (verdict) => {
      const address = { worktreeId: workspace.id, tabId: pane.tabId, leafId: pane.leafId }
      // Main withdraws panes it owns; the window still receives the verdict to release retained launch state.
      if (ORCA_LAYOUT_OWNER_IS_MAIN && verdict.kind === 'withdrawn') {
        runtime.withdrawAgentLaunchPaneInMainLayout(address)
      }
      runtime.reportAgentLaunchPaneVerdict(address, verdict)
    }
  })
}

function trackEarlyAgentLaunchTab(args: {
  paneKey: string
  publishing: Promise<AgentLaunchTabPublished>
  finishRunning: (verdict: AgentLaunchPaneVerdict) => void
  agentBound: () => void
  paneIsLive: () => boolean
  closedByUser: () => boolean
  report: (verdict: AgentLaunchPaneVerdict) => void
}): EarlyAgentLaunchTab {
  let reply: AgentLaunchTabPublished | null = null
  let publicationFailed = false
  let executing = false
  let ranHere: boolean | null = null
  const published = args.publishing.then(
    (answer) => {
      reply = answer
      return answer
    },
    (error: unknown) => {
      publicationFailed = true
      // The tab did not appear; the launch still runs and its tab appears when it spawns.
      console.warn('[agent-launch] the window did not show the launch tab early', error)
      return null
    }
  )
  return {
    paneKey: args.paneKey,
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
    windowOwnsPresentation: () => !publicationFailed,
    closedByUser: args.closedByUser,
    finish: (failureCode) => {
      if (ranHere === true) {
        // The agent's spawn bound the pane; its own spawn settles the tab.
        args.finishRunning({ kind: 'proceed' })
        return
      }
      void published.then((answer) => {
        // Remove only this request's new empty tab, never a live pane restored by replay.
        const nothingWillRunHere = !executing || ranHere === false
        const takeBack = answer?.created === true && nothingWillRunHere && !args.paneIsLive()
        // Every empty published pane needs a verdict: withdrawal, launch elsewhere, failure, or ordinary terminal.
        const live = args.paneIsLive()
        const verdict: AgentLaunchPaneVerdict =
          takeBack || (ranHere === false && !live)
            ? { kind: 'withdrawn' }
            : failureCode === undefined || live
              ? { kind: 'proceed' }
              : failureCode === null
                ? { kind: 'unconfirmed' }
                : { kind: 'not-started', code: failureCode }
        args.finishRunning(verdict)
        args.report(verdict)
      })
    },
    placement: () => reply?.placement
  }
}
