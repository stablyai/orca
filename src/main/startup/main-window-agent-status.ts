import type { BrowserWindow } from 'electron'
import { publishedOrcaSessionId } from '../agent-hooks/identity/pane-agent-identities'
import { agentHookServer } from '../agent-hooks/server/agent-hook-server'
import { setMigrationUnsupportedPtyListener } from '../agent-hooks/observations/migration-unsupported-pty-state'
import { getDashboardPopoutWindow } from '../window/dashboard-popout-window'
import { stopSyntheticTitleSpinnerTimer } from './synthetic-title-runtime'
import { mainProcessState as state } from './main-process-state'
import { pickHostTurnEnd } from '../../shared/agent-status/contracts/agent-status-types'

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
      programStatusOnly,
      agentIdentity,
      identityOnly,
      agentPresence
    }) => {
      if (state.mainWindow?.isDestroyed()) {
        return
      }
      // Renderer still owns structured rows; forwarding would give each pane key two writers until that bridge retires.
      if (structuredHost) {
        return
      }
      const launchConfig = state.runtime?.getLaunchStatementForPaneKey(paneKey, payload.agentType)
      if (providerSessionOnly) {
        // Idle Pi session_start only refreshes resume identity; skip titles, telemetry and status UI.
        state.mainWindow?.webContents.send('agentStatus:set', {
          ...payload,
          paneKey,
          ...(launchToken ? { launchToken } : {}),
          ...(launchConfig !== undefined ? { launchConfig } : {}),
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
        ...(launchConfig !== undefined ? { launchConfig } : {}),
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
        ...(publishedOrcaSessionId(agentIdentity) !== undefined
          ? { orcaSessionId: publishedOrcaSessionId(agentIdentity) }
          : {}),
        ...(promptInteractionKey ? { promptInteractionKey } : {}),
        ...(restoredUnconfirmed ? { restoredUnconfirmed: true } : {}),
        ...(observation ? { observation } : {}),
        ...(orchestration ? { orchestration } : {}),
        ...(programStatus ? { programStatus } : {}),
        ...(programStatusOnly === true ? { programStatusOnly: true } : {}),
        ...(agentPresence?.session && !agentPresence.ended
          ? { paneOwner: { agent: agentPresence.agent, session: agentPresence.session } }
          : {}),
        // Mark reconnect replays so cached completions do not notify again.
        ...(isReplay === true ? { isReplay: true } : {})
      }
      state.mainWindow?.webContents.send('agentStatus:set', statusEvent)
      getDashboardPopoutWindow()?.webContents.send('agentStatus:set', statusEvent)
      // A facet-only republish (progress tick) or a settled id is not a state the agent entered.
      if (programStatusOnly !== true && identityOnly !== true) {
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
