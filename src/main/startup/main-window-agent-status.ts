import type { BrowserWindow } from 'electron'
import { agentHookServer } from '../agent-hooks/server'
import { setMigrationUnsupportedPtyListener } from '../agent-hooks/migration-unsupported-pty-state'
import { getDashboardPopoutWindow } from '../window/dashboard-popout-window'
import { isAskUserQuestionTool } from '../../shared/agent-question-answered-intent'
import {
  getSyntheticAgentTitleProfile,
  shouldDriveSyntheticAgentTitleFromHook
} from '../../shared/synthetic-agent-title'
import {
  driveSyntheticTitleFromHook,
  shouldSuppressCodexAutoApprovalSyntheticTitleFromHook,
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

export function installMainWindowAgentStatusListeners(options: MainWindowAgentStatusOptions): void {
  agentHookServer.setListener(
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
      isReplay
    }) => {
      if (state.mainWindow?.isDestroyed()) {
        return
      }
      if (providerSessionOnly) {
        // Why: session_start just refreshes durable resume identity while Pi is idle; forward it without titles, telemetry, or status UI.
        state.mainWindow?.webContents.send('agentStatus:set', {
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
        options.maybeAutoRenameBranchOnFirstWork({ paneKey, tabId, worktreeId, payload, isReplay })
      }
      const runtime = state.runtime
      const orchestration = runtime?.getAgentStatusOrchestrationContextForPaneKey(paneKey)
      const terminalHandle = runtime?.getAgentStatusTerminalHandleForPaneKey(paneKey)
      const suppressSyntheticCodexAutoApprovalTitle =
        payload.agentType === 'codex' &&
        (payload.state === 'waiting' || payload.state === 'blocked')
          ? shouldSuppressCodexAutoApprovalSyntheticTitleFromHook({
              agentType: payload.agentType,
              state: payload.state,
              launchConfig: runtime?.getAgentStatusLaunchConfigForPaneKey(paneKey, { launchToken })
            })
          : false
      const statusEvent = {
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
      state.mainWindow?.webContents.send('agentStatus:set', statusEvent)
      if (!suppressSyntheticCodexAutoApprovalTitle || isAskUserQuestionTool(payload.toolName)) {
        getDashboardPopoutWindow()?.webContents.send('agentStatus:set', statusEvent)
      }
      options.onRecordAgentState(payload.agentType ?? 'unknown', payload.state)
      // Why: native OSC titles miss some idle/permission frames, so inject hook-derived ones to keep the renderer title tracker in sync.
      const profile = getSyntheticAgentTitleProfile(payload.agentType)
      if (
        profile &&
        shouldDriveSyntheticAgentTitleFromHook(payload.agentType, payload.state) &&
        !suppressSyntheticCodexAutoApprovalTitle
      ) {
        driveSyntheticTitleFromHook(paneKey, payload.state, profile)
      }
    }
  )
  agentHookServer.setPaneStatusClearListener((clear) => {
    if (state.mainWindow?.isDestroyed()) {
      return
    }
    state.mainWindow?.webContents.send('agentStatus:clear', clear)
    getDashboardPopoutWindow()?.webContents.send('agentStatus:clear', clear)
  })
  setMigrationUnsupportedPtyListener((event) => {
    if (state.mainWindow?.isDestroyed()) {
      return
    }
    if (event.type === 'set') {
      state.mainWindow?.webContents.send('agentStatus:migrationUnsupported', event.entry)
    } else {
      state.mainWindow?.webContents.send('agentStatus:migrationUnsupportedClear', {
        ptyId: event.ptyId
      })
    }
  })
}

export function clearMainWindowAgentStatusListeners(): void {
  // Why: detach the hook listener on close so the server never fires into destroyed webContents before reopen, and replay runs only on deliberate recreations.
  agentHookServer.setListener(null)
  agentHookServer.setPaneStatusClearListener(null)
  setMigrationUnsupportedPtyListener(null)
  // Why: stop the spinner timer here — it would fire into destroyed webContents, and per-pane teardown may never run for restored-but-untorn panes.
  stopAllSyntheticTitleSpinners()
}
