import { ipcRenderer } from 'electron'
import {
  WSL_MOVE_PROGRESS_CHANNEL,
  type WslMovePreview,
  type WslMoveProgressEvent,
  type WslMoveRequest,
  type WslMoveResult,
  type WslMoveUnfinished
} from '../../shared/wsl-move/wsl-move-driver-types'
import type {
  WslMovePendingRendererRewrite,
  WslMoveRecordStoreRewrittenRequest,
  WslMoveRecordStoreRewrittenResult
} from '../../shared/wsl-move/wsl-move-renderer-rewrite-types'
import type {
  WslMovedProjectKind,
  WslMoveUseLocallyResult
} from '../../shared/wsl-move/wsl-moved-project'
import {
  WSL_MOVE_ORCHESTRATOR_SLEPT_PANES_REQUEST_CHANNEL,
  WSL_MOVE_ORCHESTRATOR_STATUS_CHANNEL,
  type WslMoveOrchestratorRecord,
  type WslMoveOrchestratorUserAction
} from '../../shared/wsl-move/wsl-move-orchestrator-types'

/** A WSL move and the renderer half of its desktop rewrite; main gates every call. */
export type WslMoveApi = {
  preview: (request: WslMoveRequest) => Promise<WslMovePreview>
  /** Resolves when the move ends; progress arrives through `onProgress` meanwhile. */
  start: (request: WslMoveRequest) => Promise<WslMoveResult>
  /** Committed moves with host steps still pending (automations not back on yet). */
  listUnfinished: () => Promise<WslMoveUnfinished[]>
  /** True when a move of the distro was running and had not asked the host to commit yet. */
  cancel: (distro: string) => Promise<boolean>
  /** Returns the unsubscribe. */
  onProgress: (listener: (event: WslMoveProgressEvent) => void) => () => void
  listPendingRendererRewrites: () => Promise<WslMovePendingRendererRewrite[]>
  recordStoreRewritten: (
    request: WslMoveRecordStoreRewrittenRequest
  ) => Promise<WslMoveRecordStoreRewrittenResult>
  /** Drops the move that took this project, so its pre-move rows show here again. */
  useProjectHereAgain: (project: {
    kind: WslMovedProjectKind
    id: string
    /** Workspaces with unsaved files; main refuses if the move brings any of them back. */
    unsavedWorkspaceIds?: string[]
  }) => Promise<WslMoveUseLocallyResult>
  /** The general migration's per-distro state (D3a); empty while the gate is closed. */
  listOrchestrator: () => Promise<WslMoveOrchestratorRecord[]>
  /** Null when refused (gate closed, not the main window, unknown action). */
  orchestratorUserAction: (request: {
    distro: string
    action: WslMoveOrchestratorUserAction
    unsavedWorkspaceIds?: string[]
  }) => Promise<{ record: WslMoveOrchestratorRecord; release?: WslMoveUseLocallyResult } | null>
  /** T2: the window opened a bridge project of this distro; main never boots it. */
  orchestratorProjectOpened: (distro: string) => Promise<void>
  /** Returns the unsubscribe. */
  onOrchestratorStatus: (listener: (records: WslMoveOrchestratorRecord[]) => void) => () => void
  /** Main asks for the window's slept-pane bindings before an automatic move. */
  onOrchestratorSleptPanesRequest: (listener: (requestId: string) => void) => () => void
  answerOrchestratorSleptPanes: (
    requestId: string,
    sleptPanes: NonNullable<WslMoveRequest['sleptPanes']>
  ) => Promise<void>
}

export const wslMoveApi: WslMoveApi = {
  preview: (request) => ipcRenderer.invoke('wslMove:preview', request),
  start: (request) => ipcRenderer.invoke('wslMove:start', request),
  cancel: (distro) => ipcRenderer.invoke('wslMove:cancel', distro),
  listUnfinished: () => ipcRenderer.invoke('wslMove:listUnfinished'),
  onProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: WslMoveProgressEvent): void =>
      listener(progress)
    ipcRenderer.on(WSL_MOVE_PROGRESS_CHANNEL, handler)
    return () => ipcRenderer.removeListener(WSL_MOVE_PROGRESS_CHANNEL, handler)
  },
  listPendingRendererRewrites: () => ipcRenderer.invoke('wslMove:listPendingRendererRewrites'),
  recordStoreRewritten: (request) => ipcRenderer.invoke('wslMove:recordStoreRewritten', request),
  useProjectHereAgain: (project) => ipcRenderer.invoke('wslMove:useProjectHereAgain', project),
  listOrchestrator: () => ipcRenderer.invoke('wslMoveOrchestrator:list'),
  orchestratorUserAction: (request) =>
    ipcRenderer.invoke('wslMoveOrchestrator:userAction', request),
  orchestratorProjectOpened: (distro) =>
    ipcRenderer.invoke('wslMoveOrchestrator:projectOpened', distro),
  onOrchestratorStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, records: WslMoveOrchestratorRecord[]) =>
      listener(records)
    ipcRenderer.on(WSL_MOVE_ORCHESTRATOR_STATUS_CHANNEL, handler)
    return () => ipcRenderer.removeListener(WSL_MOVE_ORCHESTRATOR_STATUS_CHANNEL, handler)
  },
  onOrchestratorSleptPanesRequest: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, request: { requestId: string }) =>
      listener(request.requestId)
    ipcRenderer.on(WSL_MOVE_ORCHESTRATOR_SLEPT_PANES_REQUEST_CHANNEL, handler)
    return () =>
      ipcRenderer.removeListener(WSL_MOVE_ORCHESTRATOR_SLEPT_PANES_REQUEST_CHANNEL, handler)
  },
  answerOrchestratorSleptPanes: (requestId, sleptPanes) =>
    ipcRenderer.invoke('wslMoveOrchestrator:answerSleptPanes', { requestId, sleptPanes })
}
