/**
 * IPC for a WSL move: the move itself (preview, start, cancel), the renderer half of a committed
 * move's desktop rewrite, and bringing a moved project back to this computer. Every channel answers
 * empty / refuses while the internal WSL hosts gate is closed, before it touches anything.
 */
import { ipcMain, type WebContents } from 'electron'
import type {
  WslMovePendingRendererRewrite,
  WslMoveRecordStoreRewrittenResult
} from '../../shared/wsl-move/wsl-move-renderer-rewrite-types'
import type {
  WslMovePreview,
  WslMoveRefusal,
  WslMoveResult,
  WslMoveUnfinished
} from '../../shared/wsl-move/wsl-move-driver-types'
import { parseWslMoveRequest } from '../../shared/wsl-move/wsl-move-request'
import type { WslMoveUseLocallyResult } from '../../shared/wsl-move/wsl-moved-project'
import {
  listPendingWslMoveRendererRewrites,
  recordWslMoveRendererStoreRewritten
} from '../persistence/moving-wsl-projects/wsl-move-desktop-rewrite'
import {
  cancelWslMove,
  moveProjectsToWslHost,
  previewWslMove
} from '../persistence/moving-wsl-projects/wsl-move-driver'
import type { WslMoveDriverDeps } from '../persistence/moving-wsl-projects/wsl-move-driver-ports'
import { listUnfinishedWslMoves } from '../persistence/moving-wsl-projects/wsl-move-host-automations-rewrite'
import { runTrackedWslMove } from '../telemetry/wsl-move-telemetry'
import { runTrackedWslMoveUndo } from '../telemetry/wsl-move-undo-telemetry'
import { isAnyWslMoveRunning } from '../persistence/moving-wsl-projects/wsl-move-running-moves'
import { wslHostsGateOpen, wslHostsServing } from '../wsl/wsl-host-gate'
import type { WslMoveUndoPorts } from './wsl-move-undo-wiring'
import { releaseWslMovedProjectHere } from './wsl-move-release-here'

export const WSL_MOVE_HANDLER_CHANNELS = [
  'wslMove:listPendingRendererRewrites',
  'wslMove:recordStoreRewritten',
  'wslMove:preview',
  'wslMove:start',
  'wslMove:cancel',
  'wslMove:listUnfinished',
  'wslMove:isRunning',
  'wslMove:useProjectHereAgain'
] as const

type RendererEvent = { sender?: Pick<WebContents, 'id' | 'session'> }

export function registerWslMoveHandlers(
  getUserDataPath: () => string,
  /** The renderer stores live in the main window's storage; another window's copy is not them. */
  isMainWindowRenderer: (senderId: number) => boolean,
  /** Built per call, only once the gate is open. */
  driverDeps?: () => WslMoveDriverDeps,
  /** Undo's reach into the host; absent, there is no host to stop. */
  undoPorts: () => WslMoveUndoPorts = () => ({ stopHostCopies: async () => 'stopped' })
): void {
  for (const channel of WSL_MOVE_HANDLER_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle('wslMove:listPendingRendererRewrites', (): WslMovePendingRendererRewrite[] =>
    listPendingWslMoveRendererRewrites(getUserDataPath())
  )
  ipcMain.handle(
    'wslMove:recordStoreRewritten',
    (event: RendererEvent, request: unknown): WslMoveRecordStoreRewrittenResult => {
      // Renderer input: anything but two strings is an unknown store.
      if (
        typeof request !== 'object' ||
        request === null ||
        !('migrationId' in request) ||
        !('storeId' in request) ||
        typeof request.migrationId !== 'string' ||
        typeof request.storeId !== 'string'
      ) {
        return { recorded: false, reason: 'unknown-store' }
      }
      const sender = event.sender
      if (!sender || !isMainWindowRenderer(sender.id)) {
        return { recorded: false, reason: 'not-main-window' }
      }
      return recordWslMoveRendererStoreRewritten(
        getUserDataPath(),
        { migrationId: request.migrationId, storeId: request.storeId },
        () => sender.session.flushStorageData()
      )
    }
  )
  registerWslMoveDriverHandlers(getUserDataPath, isMainWindowRenderer, driverDeps)
  registerWslMoveUseHereHandler(getUserDataPath, isMainWindowRenderer, undoPorts)
}

function registerWslMoveDriverHandlers(
  getUserDataPath: () => string,
  isMainWindowRenderer: (senderId: number) => boolean,
  driverDeps: (() => WslMoveDriverDeps) | undefined
): void {
  // Gate first: with it closed, no dependency is built and nothing is read.
  const refuseUnlessOpen = (event: RendererEvent): WslMoveRefusal | null => {
    if (!wslHostsGateOpen() || !driverDeps) {
      return { outcome: 'refused', code: 'wsl_move_unavailable' }
    }
    const sender = event.sender
    return sender && isMainWindowRenderer(sender.id)
      ? null
      : { outcome: 'refused', code: 'wsl_move_unavailable', detail: 'not-main-window' }
  }
  ipcMain.handle(
    'wslMove:preview',
    async (event: RendererEvent, request: unknown): Promise<WslMovePreview> => {
      const parsed = parseWslMoveRequest(request)
      return (
        refuseUnlessOpen(event) ??
        (parsed && driverDeps ? previewWslMove(driverDeps(), parsed) : invalidRequest())
      )
    }
  )
  ipcMain.handle(
    'wslMove:start',
    async (event: RendererEvent, request: unknown): Promise<WslMoveResult> => {
      const parsed = parseWslMoveRequest(request)
      return (
        refuseUnlessOpen(event) ??
        (parsed && driverDeps
          ? runTrackedWslMove(driverDeps(), (deps) => moveProjectsToWslHost(deps, parsed))
          : invalidRequest())
      )
    }
  )
  ipcMain.handle('wslMove:listUnfinished', (): WslMoveUnfinished[] =>
    wslHostsServing() ? listUnfinishedWslMoves(getUserDataPath()) : []
  )
  // The quit prompt's question; a quit now loses the run, which the next launch undoes.
  ipcMain.handle('wslMove:isRunning', (): boolean => wslHostsGateOpen() && isAnyWslMoveRunning())
  ipcMain.handle(
    'wslMove:cancel',
    (event: RendererEvent, distro: unknown): boolean =>
      refuseUnlessOpen(event) === null && typeof distro === 'string' && cancelWslMove(distro)
  )
}

function invalidRequest(): WslMoveRefusal {
  return { outcome: 'refused', code: 'wsl_move_unavailable', detail: 'invalid-request' }
}

function registerWslMoveUseHereHandler(
  getUserDataPath: () => string,
  isMainWindowRenderer: (senderId: number) => boolean,
  createUndoPorts: () => WslMoveUndoPorts
): void {
  ipcMain.handle(
    'wslMove:useProjectHereAgain',
    async (event: { sender?: WebContents }, request: unknown): Promise<WslMoveUseLocallyResult> => {
      // Gate first: with it closed, nothing is read. Serve-only keeps the way back.
      if (!wslHostsServing()) {
        return { released: false, reason: 'gated-off' }
      }
      const sender = event.sender
      if (!sender || !isMainWindowRenderer(sender.id)) {
        return { released: false, reason: 'failed', detail: 'not-main-window' }
      }
      if (
        typeof request !== 'object' ||
        request === null ||
        !('kind' in request) ||
        !('id' in request) ||
        typeof request.id !== 'string' ||
        (request.kind !== 'repo' && request.kind !== 'folder')
      ) {
        return { released: false, reason: 'not-moved' }
      }
      const ref =
        request.kind === 'repo' ? { repoId: request.id } : { folderWorkspaceId: request.id }
      const unsavedWorkspaceIds =
        'unsavedWorkspaceIds' in request && Array.isArray(request.unsavedWorkspaceIds)
          ? request.unsavedWorkspaceIds.filter((id): id is string => typeof id === 'string')
          : []
      return runTrackedWslMoveUndo(
        () => performance.now(),
        () =>
          releaseWslMovedProjectHere(getUserDataPath(), ref, unsavedWorkspaceIds, createUndoPorts)
      )
    }
  )
}
