import { ipcMain } from 'electron'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { placeUnshownLiveTerminalsBestEffort } from '../runtime/terminal/adoption/unshown-live-terminal-placement'
import { recoverLegacyWorkerTerminalsForRendererStartup } from './legacy-worker-renderer-recovery'
import { logStartupMilestone } from './startup-diagnostics'
import { mainProcessState as state } from './main-process-state'
import {
  consumeQuitAndStopAllSessionsRequest,
  quitAfterRendererStoppedAllSessions
} from './main-window-actions'
import { resolveOsOpenedDocuments } from './os-opened-documents'
import {
  onStructuredAgentSessionsHeldChanged,
  structuredAgentSessionsHeld
} from '../native-chat/agent-session-wire/structured-agent-session-registry'
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
    await state.runtime?.prepareStructuredAgentSessionStartupRestoration()
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
  ipcMain.handle('app:recoverLegacyWorkerTerminalsForRendererStartup', () =>
    recoverLegacyWorkerTerminalsForRendererStartup({
      firstWindowStartupServicesReady: state.firstWindowStartupServicesReady,
      managedWslCliStartupBarrierReady: state.managedWslCliStartupBarrierReady,
      localPtyProviderStartupReady: state.localPtyProviderStartupReady,
      reconcile: async () => {
        try {
          await state.runtime?.refreshRestoredOrchestrationAuthority()
          return await state.runtime?.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
        } finally {
          // Main adopts unshown terminals after worker recovery attempts, even failures; the window no longer does.
          if (ORCA_LAYOUT_OWNER_IS_MAIN) {
            await placeUnshownLiveTerminalsBestEffort(state.runtime)
          }
        }
      },
      onDeferredRecoveryError: (error) => {
        console.warn('[orchestration] legacy worker provider-ready recovery failed', error)
      }
    })
  )
  // Renderer pulls after listener mount so early Settings requests survive.
  ipcMain.handle('ui:consumePendingOpenSettings', (event) =>
    state.pendingOpenSettings.matches(event.sender.id, { consume: true })
  )
  ipcMain.handle('ui:consumePendingQuitAndStopAllSessions', (event) =>
    consumeQuitAndStopAllSessionsRequest(event.sender.id)
  )
  ipcMain.handle('ui:quitAfterStoppingAllSessions', (event) =>
    quitAfterRendererStoppedAllSessions(event.sender.id)
  )
  ipcMain.handle('ui:consumePendingSkillShare', () => state.skillShareDeepLinks.consume())
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
