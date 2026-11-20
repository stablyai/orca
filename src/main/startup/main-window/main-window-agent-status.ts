import type { BrowserWindow } from 'electron'
import { publishedOrcaSessionId } from '../../agent-hooks/identity/pane-agent-identities'
import { agentHookServer } from '../../agent-hooks/server/agent-hook-server'
import { setMigrationUnsupportedPtyListener } from '../../agent-hooks/observations/migration-unsupported-pty-state'
import { getDashboardPopoutWindow } from '../../window/dashboard-popout-window'
import { stopSyntheticTitleSpinnerTimer } from './synthetic-title-runtime'
import { mainProcessState as state } from '../main-process-state'
import { pickHostTurnEnd } from '../../../shared/agent-status/contracts/agent-status-types'
import { cliWriterTopology } from '../../agent-hooks/server/cli-writer-topology'
import { getPtyIdForPaneKey } from '../../ipc/pty/pane/key-state'
import {
  pinnedClaudeAccountIdForPane,
  type PinnedClaudePaneLookup
} from '../../claude-accounts/pinned-claude-pane-account'

const pinnedPaneLookup: PinnedClaudePaneLookup = {
  getLivePtyIdForPaneKey: getPtyIdForPaneKey,
  getPersistedTerminalLayouts: () => state.store?.getWorkspaceSession().terminalLayoutsByTabId
}

export type MainWindowAgentStatusOptions = {
  window: BrowserWindow
  onRecordAgentState: (agentType: string, status: string) => void
}

export function installMainWindowAgentStatusListeners(options: MainWindowAgentStatusOptions): void {
  agentHookServer.setListener((row) => {
    const {
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
      paneSleep,
      agentIdentity,
      identityOnly,
      agentPresence
    } = row
    if (state.mainWindow?.isDestroyed()) {
      return
    }
    // Renderer still owns structured rows; forwarding would give each pane key two writers until that bridge retires.
    if (structuredHost) {
      return
    }
    const launchConfig = state.core.runtime?.getLaunchStatementForPaneKey(
      paneKey,
      payload.agentType
    )
    // A tmux host's conversation reaches the window as shared so it leaves no resume checkpoint.
    const shared = cliWriterTopology(row) === 'shared' ? { executionHost: 'shared' as const } : {}
    if (providerSessionOnly) {
      // An ended agent's retained identity is no conversation for the window to checkpoint.
      if (agentPresence?.ended) {
        return
      }
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
        ...shared,
        providerSessionOnly: true
      })
      return
    }
    const runtime = state.core.runtime
    const orchestration = runtime?.getAgentStatusOrchestrationContextForPaneKey(paneKey)
    const terminalHandle = runtime?.getAgentStatusTerminalHandleForPaneKey(paneKey)
    const claudeAccountId = pinnedClaudeAccountIdForPane(
      { paneKey, connectionId },
      pinnedPaneLookup
    )
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
      ...(claudeAccountId ? { claudeAccountId } : {}),
      ...(programStatus ? { programStatus } : {}),
      ...(programStatusOnly === true ? { programStatusOnly: true } : {}),
      ...(paneSleep ? { paneSleep } : {}),
      ...shared,
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
  })
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
