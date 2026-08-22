import { randomUUID } from 'node:crypto'
import type { BrowserWindow, WebContents } from 'electron'
import type {
  TerminalWindowTransferAck,
  TerminalWindowTransferPhase,
  TerminalWindowTransferSeed
} from '../../shared/terminal-window-transfer'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WindowSessionRegistry } from '../persistence/window-session-registry'
import type { PtyRendererOwners } from './pty-renderer-owners'

export type TerminalWindowTransferCommandWaiter = {
  sender: WebContents
  resolve: (ack: TerminalWindowTransferAck) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type TerminalWindowCommandReadyWaiter = {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type TerminalWindowTransfer = {
  transferId: string
  seed: TerminalWindowTransferSeed
  source: BrowserWindow
  sourceRenderer: WebContents
  target: BrowserWindow | null
  targetRenderer: WebContents | null
  sourceBefore: WorkspaceSessionState
  targetBefore: WorkspaceSessionState | null
  createdTarget: boolean
  prepared: boolean
  handedOff: boolean
  targetImportAttempted: boolean
  targetImported: boolean
  sourceRemoveAttempted: boolean
  sourceLost: boolean
  targetLost: boolean
  committed: boolean
  waiters: Map<TerminalWindowTransferPhase, TerminalWindowTransferCommandWaiter>
  abort: (error: Error) => void
  aborted: Promise<never>
  finish: () => void
  finished: Promise<void>
  sourceLossListener?: () => void
  targetLossListener?: () => void
  disposeTargetRenderer?: () => void
}

export type TerminalWindowTransferOperations = {
  sessions: WindowSessionRegistry
  owners: PtyRendererOwners
  handoff: (ptyIds: readonly string[], from: WebContents, to: WebContents) => void
  timeoutMs: number
}

export function createTerminalWindowTransfer(
  seed: TerminalWindowTransferSeed,
  source: BrowserWindow,
  sourceRenderer: WebContents,
  sourceBefore: WorkspaceSessionState
): TerminalWindowTransfer {
  let abort!: (error: Error) => void
  let finish!: () => void
  const transfer: TerminalWindowTransfer = {
    transferId: randomUUID(),
    seed,
    source,
    sourceRenderer,
    target: null,
    targetRenderer: null,
    sourceBefore,
    targetBefore: null,
    createdTarget: false,
    prepared: false,
    handedOff: false,
    targetImportAttempted: false,
    targetImported: false,
    sourceRemoveAttempted: false,
    sourceLost: false,
    targetLost: false,
    committed: false,
    waiters: new Map(),
    abort: (error) => abort(error),
    aborted: new Promise<never>((_resolve, reject) => {
      abort = reject
    }),
    finish: () => finish(),
    finished: new Promise<void>((resolve) => {
      finish = resolve
    })
  }
  void transfer.aborted.catch(() => {})
  return transfer
}

export function prepareTerminalWindowTargetRecord(
  state: WorkspaceSessionState,
  seed: TerminalWindowTransferSeed
): WorkspaceSessionState {
  return {
    ...state,
    terminalLayoutsByTabId: {
      ...state.terminalLayoutsByTabId,
      [seed.tabId]: structuredClone(seed.layout)
    }
  }
}

export function getTerminalWindowBounds(
  point: Electron.Point,
  workArea: Electron.Rectangle
): Electron.Rectangle {
  const width = Math.min(1200, workArea.width)
  const height = Math.min(800, workArea.height)
  return {
    x: Math.max(workArea.x, Math.min(point.x - width / 2, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(point.y - 24, workArea.y + workArea.height - height)),
    width,
    height
  }
}

export function isPointInsideRectangle(
  point: Electron.Point,
  rectangle: Electron.Rectangle
): boolean {
  return (
    point.x >= rectangle.x &&
    point.y >= rectangle.y &&
    point.x < rectangle.x + rectangle.width &&
    point.y < rectangle.y + rectangle.height
  )
}

export function installTerminalWindowTransferAbortListeners(
  operations: TerminalWindowTransferOperations,
  transfer: TerminalWindowTransfer
): void {
  const sourceLost = (): void => {
    if (transfer.committed) {
      return
    }
    transfer.sourceLost = true
    transfer.abort(new Error('terminal_transfer_source_lost'))
  }
  const targetLost = (): void => {
    if (transfer.committed) {
      return
    }
    transfer.targetLost = true
    if (
      transfer.handedOff &&
      transfer.targetRenderer &&
      !transfer.sourceRenderer.isDestroyed() &&
      operations.owners.isRegistered(transfer.sourceRenderer) &&
      operations.owners.isDispatcherReady(transfer.sourceRenderer)
    ) {
      try {
        operations.handoff(transfer.seed.ptyIds, transfer.targetRenderer, transfer.sourceRenderer)
        transfer.handedOff = false
      } catch {
        // Async rollback waits for a recovering source renderer if needed.
      }
    }
    transfer.abort(new Error('terminal_transfer_target_lost'))
  }
  transfer.sourceLossListener = sourceLost
  transfer.targetLossListener = targetLost
  transfer.source.once('close', sourceLost)
  transfer.sourceRenderer.once('render-process-gone', sourceLost)
  transfer.target?.once('close', targetLost)
  transfer.targetRenderer?.once('render-process-gone', targetLost)
}

export function removeTerminalWindowTransferAbortListeners(transfer: TerminalWindowTransfer): void {
  const { sourceLossListener, targetLossListener } = transfer
  if (!sourceLossListener || !targetLossListener) {
    return
  }
  if (!transfer.source.isDestroyed()) {
    transfer.source.removeListener('close', sourceLossListener)
  }
  transfer.sourceRenderer.removeListener('render-process-gone', sourceLossListener)
  if (transfer.target && !transfer.target.isDestroyed()) {
    transfer.target.removeListener('close', targetLossListener)
  }
  transfer.targetRenderer?.removeListener('render-process-gone', targetLossListener)
}

export function finishCommittedTerminalWindowTransfer(
  transfer: TerminalWindowTransfer,
  sourceEmpty: boolean,
  isSourceSecondary: () => boolean,
  retireSource: () => void
): void {
  const { source } = transfer
  revealCreatedTerminalWindowTarget(transfer)
  try {
    if (sourceEmpty && isSourceSecondary()) {
      try {
        retireSource()
      } finally {
        source.close()
      }
    }
  } catch {
    // Empty-window cleanup follows the committed transaction.
  }
}

export function revealCreatedTerminalWindowTarget(transfer: TerminalWindowTransfer): void {
  const { target } = transfer
  if (!transfer.createdTarget || !target || target.isDestroyed()) {
    return
  }
  try {
    target.show()
  } catch {
    // The transfer backing survives a reveal failure.
  }
  try {
    target.focus()
  } catch {
    // The last owner must not roll back on a focus failure.
  }
}
