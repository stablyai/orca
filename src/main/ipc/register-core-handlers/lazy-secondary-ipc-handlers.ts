import type { Store } from '../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { StatsCollector } from '../../stats/collector'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'

export const HOSTED_REVIEW_IPC_CHANNELS = [
  'hostedReview:forBranch',
  'hostedReview:getCreationEligibility',
  'hostedReview:create',
  'hostedReview:createStacked'
] as const

export const WORKSPACE_SPACE_IPC_CHANNELS = [
  'workspaceSpace:analyze',
  'workspaceSpace:getCachedAnalysis',
  'workspaceSpace:cancel'
] as const

export const WORKSPACE_SPACE_WINDOW_IPC_CHANNELS = [
  'workspaceSpace:openWindow',
  'workspaceSpace:publishWindowState',
  'workspaceSpace:requestWindowState',
  'workspaceSpace:revealWorktree',
  'workspaceSpace:requestWorktreeRefresh',
  'workspaceSpace:requestIssueRefresh',
  'workspaceSpace:publishWindowAnalysis'
] as const

export const TERMINAL_PREVIEW_IPC_CHANNELS = [
  'terminalPreview:connect',
  'terminalPreview:unsubscribe',
  'terminalPreview:input',
  'terminalPreview:ack',
  'terminalPreview:fit'
] as const

export const TERMINAL_RENDER_DESYNC_EVIDENCE_IPC_CHANNELS = [
  'terminal:writeRenderDesyncEvidence'
] as const

export const BROWSER_SERVER_DOWNLOAD_COPY_IPC_CHANNELS = [
  'browser:copyServerDownload',
  'browser:cancelServerDownloadCopy'
] as const

export const MEMORY_IPC_CHANNELS = [
  'memory:getSnapshot',
  'memory:readPerfNoticeSignals',
  'memory:countHiddenBrowserPages',
  'memory:resourceWindowVisible'
] as const

export function registerLazySecondaryIpcHandlers(
  store: Store,
  stats: StatsCollector,
  runtime: OrcaRuntimeService
): void {
  registerLazyIpcHandleGroup(HOSTED_REVIEW_IPC_CHANNELS, async (ipc) => {
    const { registerHostedReviewHandlers } = await import('../source-control/hosted-review')
    registerHostedReviewHandlers(store, stats, ipc)
  })
  registerLazyIpcHandleGroup(WORKSPACE_SPACE_IPC_CHANNELS, async (ipc) => {
    const { registerWorkspaceSpaceHandlers } = await import('../workspace-space/workspace-space')
    registerWorkspaceSpaceHandlers(store, ipc)
  })
  registerLazyIpcHandleGroup(WORKSPACE_SPACE_WINDOW_IPC_CHANNELS, async (ipc) => {
    const { registerWorkspaceSpaceWindowHandlers } =
      await import('../workspace-space/workspace-space-window')
    registerWorkspaceSpaceWindowHandlers(store, ipc)
  })
  registerLazyIpcHandleGroup(TERMINAL_PREVIEW_IPC_CHANNELS, async (ipc) => {
    const { registerTerminalPreviewHandlers } = await import('../terminal-views/terminal-preview')
    registerTerminalPreviewHandlers(runtime, ipc)
  })
  registerLazyIpcHandleGroup(TERMINAL_RENDER_DESYNC_EVIDENCE_IPC_CHANNELS, async (ipc) => {
    const { registerTerminalRenderDesyncEvidenceHandler } =
      await import('../terminal-views/terminal-render-desync-evidence')
    registerTerminalRenderDesyncEvidenceHandler(ipc)
  })
  registerLazyIpcHandleGroup(BROWSER_SERVER_DOWNLOAD_COPY_IPC_CHANNELS, async (ipc) => {
    const { registerBrowserServerDownloadCopyHandlers } =
      await import('../browser/browser-server-download-copy-ipc')
    registerBrowserServerDownloadCopyHandlers(ipc)
  })
  registerLazyIpcHandleGroup(MEMORY_IPC_CHANNELS, async (ipc) => {
    const { registerMemoryHandlers } = await import('../memory')
    registerMemoryHandlers(store, ipc)
  })
}
