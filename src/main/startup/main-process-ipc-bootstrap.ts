import { readSessionWorkers } from '../runtime/rpc/methods/orchestration/worker/session-workers-method'
import { ipcMain } from 'electron'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/workspace-layout/layout-owner-switch'
import { placeUnshownLiveTerminalsBestEffort } from '../runtime/terminal/adoption/unshown-live-terminal-placement'
import { recoverLegacyWorkerTerminalsForRendererStartup } from './pty-startup/legacy-worker-renderer-recovery'
import { logStartupMilestone } from './diagnostics/startup-diagnostics'
import { mainProcessState as state } from './main-process-state'
import {
  consumeQuitAndStopAllSessionsRequest,
  quitAfterRendererStoppedAllSessions
} from './main-window/main-window-actions'
import { resolveOsOpenedDocuments } from './open-routing/os-opened-documents'
import { openBotDeepLink } from '../bots/bot-deep-link-open'
import { areHostBotsEnabled } from '../bots/bot-team-policy'
import {
  onStructuredAgentSessionsHeldChanged,
  structuredAgentSessionsHeld
} from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { subscribeAgentSessionUploadRemoval } from '../native-chat/agent-session-attachments/agent-session-attachment-store-registry'

export function registerMainProcessIpcHandlers(): void {
  ipcMain.handle('app:awaitFirstWindowStartupServices', async () => {
    await Promise.all([
      state.firstWindowStartupServicesReady,
      state.managedWslCliStartupBarrierReady
    ])
  })
  // Git needs shell PATH/WSL registration, not daemon/hooks; separate barriers keep worktree hydration off terminal startup.
  ipcMain.handle('app:awaitGitEnvironmentStartupBarrier', async () => {
    await Promise.all([state.shellPathReady, state.managedWslCliStartupBarrierReady])
  })
  ipcMain.handle('app:prepareTerminalStartupRestoration', async () => {
    await Promise.all([
      state.firstWindowStartupServicesReady,
      state.managedWslCliStartupBarrierReady
    ])
    await state.core.runtime?.prepareStructuredAgentSessionStartupRestoration()
  })
  // Only hosts holding a saved/new structured chat have local rows for the renderer to mirror.
  ipcMain.handle('app:holdsStructuredAgentSessions', () => structuredAgentSessionsHeld())
  onStructuredAgentSessionsHeldChanged((held) => {
    const window = state.mainWindow
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('app:structuredAgentSessionsHeldChanged', held)
    }
  })
  // Draft restore checks pastes only once; notify when a later sweep removes them.
  subscribeAgentSessionUploadRemoval((uploadDir) => {
    const window = state.mainWindow
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('app:agentSessionUploadRemoved', uploadDir)
    }
  })
  ipcMain.handle('app:recoverLegacyWorkerTerminalsForRendererStartup', (_event, options) =>
    recoverLegacyWorkerTerminalsForRendererStartup({
      firstWindowStartupServicesReady: state.firstWindowStartupServicesReady,
      managedWslCliStartupBarrierReady: state.managedWslCliStartupBarrierReady,
      localPtyProviderStartupReady: state.localPtyProviderStartupReady,
      reconcile: async () => {
        try {
          await state.core.runtime?.refreshRestoredOrchestrationAuthority()
          return await state.core.runtime?.reconcileLegacyWorkerTerminals({
            materializeRenderer: true
          })
        } finally {
          // Main adopts unshown terminals after worker recovery attempts, even failures; the window no longer does.
          if (ORCA_LAYOUT_OWNER_IS_MAIN) {
            await placeUnshownLiveTerminalsBestEffort(state.core.runtime)
          }
        }
      },
      onDeferredRecoveryError: (error) => {
        console.warn('[orchestration] legacy worker provider-ready recovery failed', error)
      }
    }).finally(() => {
      // Only the pass after terminal reconnect leaves every restored worker terminal resolvable.
      if (options?.afterReconnect === true) {
        state.core.runtime?.startupWorkerAuthority.finish()
        void state.core.runtime?.reportWorkerStopsAcrossRestartOnce()
      }
    })
  )
  // Renderer pulls after listener mount so early Settings requests survive.
  ipcMain.handle('ui:consumePendingOpenSettings', (event) =>
    state.pendingOpenSettings.matches(event.sender.id, { consume: true })
  )
  ipcMain.handle('ui:consumePendingSkillShare', () => state.deepLinks.consumeSkillShare())
  ipcMain.handle('ui:consumePendingBotLink', () => {
    // Bots off: the link only brings Orca forward.
    if (!areHostBotsEnabled(state.store?.getSettings())) {
      state.deepLinks.discardConnectorLinks()
      state.deepLinks.consumeBotLink()
      return null
    }
    // Rides the bot link's doorbell; the renderer pulls again for any link pending beside it.
    const connectorLink = state.deepLinks.consumeConnectorLink()
    if (connectorLink) {
      return { kind: 'connector-link', ...connectorLink }
    }
    const accessRequest = state.deepLinks.consumeAccessRequest()
    if (accessRequest) {
      return { kind: 'access-request', ...accessRequest }
    }
    const botShareId = state.deepLinks.consumeBotShare()
    if (botShareId) {
      return { kind: 'bot-share', shareId: botShareId }
    }
    const link = state.deepLinks.consumeBotLink()
    if (!link) {
      return null
    }
    return state.store
      ? openBotDeepLink(state.store, link, async (sessionId) =>
          state.core.runtime
            ? readSessionWorkers(state.core.runtime, sessionId, { connectorOnly: true })
            : []
        )
      : { kind: 'missing' }
  })
  ipcMain.handle('ui:consumePendingQuitAndStopAllSessions', (event) =>
    consumeQuitAndStopAllSessionsRequest(event.sender.id)
  )
  ipcMain.handle('ui:quitAfterStoppingAllSessions', (event) =>
    quitAfterRendererStoppedAllSessions(event.sender.id)
  )
  ipcMain.handle('ui:consumePendingPluginInstallLink', () => state.pluginInstallLinks.consume())
  ipcMain.handle('ui:consumePendingSshConnectLink', () => state.sshConnectLinks.consume())
  // Pull delivers cold-start Open With and proves the listener is ready for later pushes.
  ipcMain.handle('ui:consumePendingMarkdownFileOpens', async () => {
    state.osDocumentOpenListenerReady = true
    const filePaths = state.osOpenedDocuments.consume()
    try {
      return await resolveOsOpenedDocuments(filePaths)
    } catch (error) {
      // Restore undelivered paths so a later renderer mount can retry.
      state.osOpenedDocuments.restore(filePaths)
      throw error
    }
  })
  ipcMain.handle(
    'app:startupDiagnostic',
    (_event, event: string, details?: Record<string, unknown>) => {
      if (!state.startupDiagnosticsEnabled || !event.startsWith('renderer-')) {
        return
      }
      logStartupMilestone(event, details && typeof details === 'object' ? details : {})
    }
  )
}
