import type { BrowserWindow, WebContents } from 'electron'
import { agentHookServer } from '../agent-hooks/server'
import { setMigrationUnsupportedPtyListener } from '../agent-hooks/migration-unsupported-pty-state'
import { getDashboardPopoutWindow } from '../window/dashboard-popout-window'
import {
  getSyntheticAgentTitleProfile,
  shouldDriveSyntheticAgentTitleFromHook
} from '../../shared/synthetic-agent-title'
import {
  driveSyntheticTitleFromHook,
  stopAllSyntheticTitleSpinners
} from './synthetic-title-runtime'
import { mainProcessState as state } from './main-process-state'

export type MainWindowAgentStatusOptions = {
  window: BrowserWindow
  maybeAutoRenameBranchOnFirstWork: (event: {
    paneKey: string
    tabId: string | undefined
    worktreeId: string | undefined
    payload: { state: string; prompt?: string; lastAssistantMessage?: string }
    isReplay: boolean | undefined
  }) => void
  onRecordAgentState: (agentType: string, status: string) => void
}

// Why: this window's subscriptions, ended by `clearMainWindowAgentStatusListeners` when it closes.
// The server keeps no slot for us, so ending them is the only thing that stops delivery here.
let unsubscribeWindowStatusDelivery: (() => void)[] = []

/** This window's webContents while it can still receive. A torn-down window is not a reason to
 *  skip the other status surfaces — that coupling is what silenced the dashboard pop-out. */
function liveWebContents(window: BrowserWindow): WebContents | null {
  return window.isDestroyed() ? null : window.webContents
}

function endWindowStatusSubscriptions(): void {
  for (const unsubscribe of unsubscribeWindowStatusDelivery) {
    unsubscribe()
  }
  unsubscribeWindowStatusDelivery = []
}

export function installMainWindowAgentStatusListeners(options: MainWindowAgentStatusOptions): void {
  // Why: install replaces rather than accumulates, matching the slot it succeeds — a second
  // install would otherwise send every status event twice.
  endWindowStatusSubscriptions()
  const window = options.window
  unsubscribeWindowStatusDelivery.push(
    agentHookServer.subscribeEnrichedStatus(
      ({
        paneKey,
        tabId,
        worktreeId,
        connectionId,
        payload,
        receivedAt,
        evidenceObservedAt,
        stateStartedAt,
        launchToken,
        providerSession,
        providerSessionOnly,
        promptInteractionKey,
        restoredUnconfirmed,
        observation,
        isReplay,
        authorityRestartId,
        structuredHost
      }) => {
        // Why: the renderer still derives structured rows from its own feed subscription; forwarding
        // these too would give one pane key two writers until that bridge is retired.
        if (structuredHost) {
          return
        }
        if (providerSessionOnly) {
          // Why: session_start just refreshes durable resume identity while Pi is idle; forward it without titles, telemetry, or status UI.
          liveWebContents(window)?.send('agentStatus:set', {
            ...payload,
            paneKey,
            ...(launchToken ? { launchToken } : {}),
            tabId,
            worktreeId,
            connectionId,
            receivedAt,
            ...(evidenceObservedAt !== undefined ? { evidenceObservedAt } : {}),
            stateStartedAt,
            ...(providerSession ? { providerSession } : {}),
            ...(observation ? { observation } : {}),
            providerSessionOnly: true
          })
          return
        }
        if (!restoredUnconfirmed) {
          options.maybeAutoRenameBranchOnFirstWork({
            paneKey,
            tabId,
            worktreeId,
            payload,
            isReplay
          })
        }
        const runtime = state.runtime
        const orchestration = runtime?.getAgentStatusOrchestrationContextForPaneKey(paneKey)
        const terminalHandle = runtime?.getAgentStatusTerminalHandleForPaneKey(paneKey)
        const statusEvent = {
          ...(authorityRestartId && isReplay !== true ? { authorityRestartId } : {}),
          ...payload,
          paneKey,
          ...(launchToken ? { launchToken } : {}),
          ...(terminalHandle ? { terminalHandle } : {}),
          tabId,
          worktreeId,
          connectionId,
          receivedAt,
          ...(evidenceObservedAt !== undefined ? { evidenceObservedAt } : {}),
          stateStartedAt,
          ...(providerSession ? { providerSession } : {}),
          ...(promptInteractionKey ? { promptInteractionKey } : {}),
          ...(restoredUnconfirmed ? { restoredUnconfirmed: true } : {}),
          ...(observation ? { observation } : {}),
          ...(orchestration ? { orchestration } : {})
        }
        liveWebContents(window)?.send('agentStatus:set', statusEvent)
        getDashboardPopoutWindow()?.webContents.send('agentStatus:set', statusEvent)
        options.onRecordAgentState(payload.agentType ?? 'unknown', payload.state)
        // Why: native OSC titles miss some idle/permission frames, so inject hook-derived ones to keep the renderer title tracker in sync.
        const profile = getSyntheticAgentTitleProfile(payload.agentType)
        if (profile && shouldDriveSyntheticAgentTitleFromHook(payload.agentType, payload.state)) {
          driveSyntheticTitleFromHook(paneKey, payload.state, profile)
        }
      },
      // Why: a freshly created window has no rows; replay is how it catches up on what the
      // store observed while it was closed, or before it first opened.
      { replay: true }
    )
  )
  unsubscribeWindowStatusDelivery.push(
    agentHookServer.subscribePaneStatusClear((clear) => {
      liveWebContents(window)?.send('agentStatus:clear', clear)
      getDashboardPopoutWindow()?.webContents.send('agentStatus:clear', clear)
    })
  )
  setMigrationUnsupportedPtyListener((event) => {
    if (event.type === 'set') {
      liveWebContents(window)?.send('agentStatus:migrationUnsupported', event.entry)
    } else {
      liveWebContents(window)?.send('agentStatus:migrationUnsupportedClear', { ptyId: event.ptyId })
    }
  })
}

export function clearMainWindowAgentStatusListeners(): void {
  // Why: end this window's subscriptions on close so the server never fires into destroyed
  // webContents before reopen, and replay runs only on deliberate recreations. Other subscribers
  // — stats, awake-blocking, session-tabs republish, the plugin bus — are untouched.
  endWindowStatusSubscriptions()
  setMigrationUnsupportedPtyListener(null)
  // Why: stop the spinner timer here — it would fire into destroyed webContents, and per-pane teardown may never run for restored-but-untorn panes.
  stopAllSyntheticTitleSpinners()
}
