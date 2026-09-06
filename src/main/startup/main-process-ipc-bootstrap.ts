import { ipcMain } from 'electron'
import { recoverLegacyWorkerTerminalsForRendererStartup } from './legacy-worker-renderer-recovery'
import { logStartupMilestone } from './startup-diagnostics'
import { mainProcessState as state } from './main-process-state'
import { resolveOpenedMarkdownDocuments } from './os-opened-markdown-files'

export function registerMainProcessIpcHandlers(): void {
  ipcMain.handle('app:awaitFirstWindowStartupServices', async () => {
    await Promise.all([
      state.firstWindowStartupServicesReady,
      state.managedWslCliStartupBarrierReady
    ])
  })
  // Why separate from the first-window barrier: host Git needs the shell-PATH
  // generation and the managed WSL CLI registration, not a daemon PTY provider
  // or a hook-server bind. Bundling them made worktree hydration wait on a
  // terminal service it never calls.
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
  ipcMain.handle('app:recoverLegacyWorkerTerminalsForRendererStartup', () =>
    recoverLegacyWorkerTerminalsForRendererStartup({
      firstWindowStartupServicesReady: state.firstWindowStartupServicesReady,
      managedWslCliStartupBarrierReady: state.managedWslCliStartupBarrierReady,
      localPtyProviderStartupReady: state.localPtyProviderStartupReady,
      reconcile: async () => {
        await state.runtime?.refreshRestoredOrchestrationAuthority()
        return state.runtime?.reconcileLegacyWorkerTerminals({ materializeRenderer: true })
      },
      onDeferredRecoveryError: (error) => {
        console.warn('[orchestration] legacy worker provider-ready recovery failed', error)
      }
    })
  )
  // Why: the renderer pulls this once its ui:openSettings listener attaches, so a Settings request queued before mount isn't lost.
  ipcMain.handle('ui:consumePendingOpenSettings', (event) =>
    state.pendingOpenSettings.matches(event.sender.id, { consume: true })
  )
  ipcMain.handle('ui:consumePendingSkillShare', () => state.skillShareDeepLinks.consume())
  // Why: the renderer pulls this once its ui:openMarkdownFiles listener attaches, so a
  // cold-start "Open With" queued before mount still opens. The pull doubles as the proof
  // that the listener is live, which is what lets main start pushing.
  ipcMain.handle('ui:consumePendingMarkdownFileOpens', async () => {
    state.markdownFileOpenListenerReady = true
    const filePaths = state.osOpenedMarkdownFiles.consume()
    try {
      return await resolveOpenedMarkdownDocuments(filePaths)
    } catch (error) {
      // Why restored: the renderer never received these, so a later mount must still get them.
      state.osOpenedMarkdownFiles.restore(filePaths)
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
