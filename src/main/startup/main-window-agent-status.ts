import type { BrowserWindow } from 'electron'
import { agentHookServer } from '../agent-hooks/server'
import { setMigrationUnsupportedPtyListener } from '../agent-hooks/migration-unsupported-pty-state'
import { getDashboardPopoutWindow } from '../window/dashboard-popout-window'
import { stopSyntheticTitleSpinnerTimer } from './synthetic-title-runtime'
import { mainProcessState as state } from './main-process-state'
import { pickHostTurnEnd } from '../../shared/agent-status-types'

export type MainWindowAgentStatusOptions = {
  window: BrowserWindow
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
      turnStartedAt,
      turnEndedAt,
      turnEndDisposition,
      launchToken,
      providerSession,
      providerSessionOnly,
      promptInteractionKey,
      restoredUnconfirmed,
      observation,
      isReplay,
      authorityRestartId,
      structuredHost,
      programStatus,
      programStatusOnly
    }) => {
      if (state.mainWindow?.isDestroyed()) {
        return
      }
      // Renderer still owns structured rows; forwarding would give each pane key two writers until that bridge retires.
      if (structuredHost) {
        return
      }
      if (providerSessionOnly) {
        // Idle Pi session_start only refreshes resume identity; skip titles, telemetry and status UI.
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
        ...(turnStartedAt !== undefined ? { turnStartedAt } : {}),
        ...pickHostTurnEnd({ turnEndedAt, turnEndDisposition }),
        ...(providerSession ? { providerSession } : {}),
        ...(promptInteractionKey ? { promptInteractionKey } : {}),
        ...(restoredUnconfirmed ? { restoredUnconfirmed: true } : {}),
        ...(observation ? { observation } : {}),
        ...(orchestration ? { orchestration } : {}),
        ...(programStatus ? { programStatus } : {}),
        ...(programStatusOnly === true ? { programStatusOnly: true } : {}),
        // Mark reconnect replays so cached completions do not notify again.
        ...(isReplay === true ? { isReplay: true } : {})
      }
      state.mainWindow?.webContents.send('agentStatus:set', statusEvent)
      getDashboardPopoutWindow()?.webContents.send('agentStatus:set', statusEvent)
      // A facet-only republish (progress tick) is not a state the agent entered.
      if (programStatusOnly !== true) {
        options.onRecordAgentState(payload.agentType ?? 'unknown', payload.state)
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
  // Detach window listeners before destroyed WebContents; only deliberate window recreation replays.
  agentHookServer.setListener(null)
  agentHookServer.setPaneStatusClearListener(null)
  setMigrationUnsupportedPtyListener(null)
  // Stop the timer only; retained working entries resume on reopened show without hook replay.
  stopSyntheticTitleSpinnerTimer()
}
