import {
  publishToDocuments,
  registerAppHandler,
  appDocumentFor
} from '../ipc/app-registry/app-handler-registry'
import { installElectronAppIpc } from '../ipc/app-registry/electron-app-ipc'
import { isTrustedUIRenderer, getTrustedUIRendererWebContents } from '../ipc/ui'
import { isDashboardPopoutRenderer } from '../window/dashboard-popout-window'
import { isWorkspaceSpaceWindowRenderer } from '../window/workspace-space-window'
import { readSessionWorkers } from '../runtime/rpc/methods/orchestration/worker/session-workers-method'

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
import {
  onStructuredAgentSessionsHeldChanged,
  structuredAgentSessionsHeld
} from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { subscribeAgentSessionUploadRemoval } from '../native-chat/agent-session-attachments/agent-session-attachment-store-registry'

export function registerMainProcessIpcHandlers(): void {
  installElectronAppIpc(
    (sender) =>
      isTrustedUIRenderer(sender)
        ? 'main'
        : isDashboardPopoutRenderer(sender)
          ? 'dashboard-popout'
          : isWorkspaceSpaceWindowRenderer(sender)
            ? 'workspace-space'
            : 'document',
    (sender) => getTrustedUIRendererWebContents() === sender
  )
  registerAppHandler('app:awaitFirstWindowStartupServices', async () => {
    await Promise.all([
      state.firstWindowStartupServicesReady,
      state.managedWslCliStartupBarrierReady
    ])
  })
  // Git needs shell PATH/WSL registration, not daemon/hooks; separate barriers keep worktree hydration off terminal startup.
  registerAppHandler('app:awaitGitEnvironmentStartupBarrier', async () => {
    await Promise.all([state.shellPathReady, state.managedWslCliStartupBarrierReady])
  })
  registerAppHandler('app:prepareTerminalStartupRestoration', async () => {
    await Promise.all([
      state.firstWindowStartupServicesReady,
      state.managedWslCliStartupBarrierReady
    ])
    await state.core.runtime?.prepareStructuredAgentSessionStartupRestoration()
  })
  // Only hosts holding a saved/new structured chat have local rows for the renderer to mirror.
  registerAppHandler('app:holdsStructuredAgentSessions', () => structuredAgentSessionsHeld())
  onStructuredAgentSessionsHeldChanged((held) => {
    const window = state.mainWindow
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      publishToDocuments('app:structuredAgentSessionsHeldChanged', held, {
        sourceId: window.webContents.id
      })
    }
  })
  // Draft restore checks pastes only once; notify when a later sweep removes them.
  subscribeAgentSessionUploadRemoval((uploadDir) => {
    const window = state.mainWindow
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      publishToDocuments('app:agentSessionUploadRemoved', uploadDir, {
        sourceId: window.webContents.id
      })
    }
  })
  registerAppHandler('app:recoverLegacyWorkerTerminalsForRendererStartup', (_event, options) =>
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
  registerAppHandler('ui:consumePendingOpenSettings', (event) =>
    state.pendingOpenSettings.matches(appDocumentFor(event).id, { consume: true })
  )
  registerAppHandler('ui:consumePendingSkillShare', () => state.deepLinks.consumeSkillShare())
  registerAppHandler('ui:consumePendingBotLink', () => {
    // Bots off: the link only brings Orca forward.
    if (state.store?.getSettings().botsEnabled === false) {
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
  registerAppHandler('ui:consumePendingQuitAndStopAllSessions', (event) =>
    consumeQuitAndStopAllSessionsRequest(appDocumentFor(event).id)
  )
  registerAppHandler('ui:quitAfterStoppingAllSessions', (event) =>
    quitAfterRendererStoppedAllSessions(appDocumentFor(event).id)
  )
  registerAppHandler('ui:consumePendingPluginInstallLink', () => state.pluginInstallLinks.consume())
  // Pull delivers cold-start Open With and proves the listener is ready for later pushes.
  registerAppHandler('ui:consumePendingMarkdownFileOpens', async () => {
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
  registerAppHandler(
    'app:startupDiagnostic',
    (_event, event: string, details?: Record<string, unknown>) => {
      if (!state.startupDiagnosticsEnabled || !event.startsWith('renderer-')) {
        return
      }
      logStartupMilestone(event, details && typeof details === 'object' ? details : {})
    }
  )
}
