import type { BrowserWindow, WebContents } from 'electron'
import { LOCAL_EXECUTION_HOST_ID, normalizeExecutionHostId } from '../../shared/execution-host'
import { isWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
import type {
  TerminalWindowTransferAck,
  TerminalWindowTransferPhase,
  TerminalWindowTransferSeed
} from '../../shared/terminal-window-transfer'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WindowSessionRegistry } from '../persistence/window-session-registry'
import { sendToPtyOwner } from './pty'
import type { PtyRendererOwners } from './pty-renderer-owners'
import { sendTerminalWindowTransferCommand } from './terminal-window-transfer-command'
import {
  removeTransferredTerminalSession,
  restoreTransferredTerminalSession
} from './terminal-window-transfer-session-patch'

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
  sourceRemoveAttempted: boolean
  committed: boolean
  waiters: Map<TerminalWindowTransferPhase, TerminalWindowTransferCommandWaiter>
  abort: (error: Error) => void
  aborted: Promise<never>
  finish: () => void
  finished: Promise<void>
  fail?: () => void
  disposeTargetRenderer?: () => void
}

export type TerminalWindowTransferOperations = {
  sessions: WindowSessionRegistry
  owners: PtyRendererOwners
  handoff: (ptyIds: readonly string[], from: WebContents, to: WebContents) => void
  timeoutMs: number
}

export function sessionHasTerminalTab(state: WorkspaceSessionState, tabId: string): boolean {
  return Object.values(state.tabsByWorktree).some((tabs) => tabs.some((tab) => tab.id === tabId))
}

export function sessionHasTerminalTransferSource(
  state: WorkspaceSessionState,
  seed: TerminalWindowTransferSeed
): boolean {
  return (
    state.tabsByWorktree[seed.worktreeId]?.some(
      (tab) => tab.id === seed.tabId && tab.worktreeId === seed.worktreeId
    ) === true && Boolean(state.terminalLayoutsByTabId[seed.tabId])
  )
}

export function sessionMatchesTerminalWindowTarget(
  state: WorkspaceSessionState,
  seed: TerminalWindowTransferSeed
): boolean {
  const workspaceKey = state.activeWorkspaceKey
    ? state.activeWorkspaceKey
    : state.activeWorktreeId
      ? isWorkspaceKey(state.activeWorktreeId)
        ? state.activeWorktreeId
        : worktreeWorkspaceKey(state.activeWorktreeId)
      : null
  const hostId =
    normalizeExecutionHostId(state.activeWorkspaceExecutionHostId) ?? LOCAL_EXECUTION_HOST_ID
  return workspaceKey === seed.canonicalWorkspaceKey && hostId === seed.hostId
}

export function getTerminalWindowTransferSourceError(
  state: WorkspaceSessionState,
  seed: TerminalWindowTransferSeed,
  owns: (ptyId: string) => boolean
): string | null {
  if (!sessionHasTerminalTransferSource(state, seed)) {
    return 'terminal_transfer_source_missing'
  }
  if (!sessionMatchesTerminalWindowTarget(state, seed)) {
    return 'terminal_transfer_source_mismatch'
  }
  return seed.ptyIds.some((id) => !owns(id)) ? 'terminal_transfer_source_not_owner' : null
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

export async function rollbackTerminalWindowTransfer(
  operations: TerminalWindowTransferOperations,
  transfer: TerminalWindowTransfer
): Promise<void> {
  if (!transfer.prepared || transfer.committed) {
    return
  }
  const { source, sourceRenderer, target, targetRenderer, seed } = transfer
  if (transfer.handedOff && targetRenderer) {
    try {
      operations.handoff(seed.ptyIds, targetRenderer, sourceRenderer)
      transfer.handedOff = false
    } catch {
      try {
        await operations.owners.waitUntilDispatcherReady(sourceRenderer, operations.timeoutMs)
        operations.handoff(seed.ptyIds, targetRenderer, sourceRenderer)
        transfer.handedOff = false
      } catch {
        // Keep the PTY with its last live owner; record snapshots still prevent durable loss.
      }
    }
  }
  const commands: Promise<unknown>[] = []
  if (transfer.targetImportAttempted && targetRenderer && !targetRenderer.isDestroyed()) {
    commands.push(
      sendTerminalWindowTransferCommand(
        operations,
        transfer,
        targetRenderer,
        { transferId: transfer.transferId, tabId: seed.tabId, phase: 'target-remove' },
        true
      ).catch(() => undefined)
    )
  }
  if (transfer.sourceRemoveAttempted && !sourceRenderer.isDestroyed()) {
    commands.push(
      sendTerminalWindowTransferCommand(
        operations,
        transfer,
        sourceRenderer,
        { transferId: transfer.transferId, tabId: seed.tabId, phase: 'source-restore', seed },
        true
      ).catch(() => undefined)
    )
  }
  await Promise.all(commands)
  if (seed.ptyIds.every((id) => operations.owners.owns(id, sourceRenderer))) {
    for (const id of seed.ptyIds) {
      try {
        sendToPtyOwner(id, 'pty:modelRestoreNeeded', { id, reason: 'delivery-heal' })
      } catch {
        // Delivery healing is best-effort after ownership is restored.
      }
    }
  }
  try {
    operations.sessions.set(
      source.id,
      restoreTransferredTerminalSession(
        operations.sessions.get(source.id, seed.hostId),
        transfer.sourceBefore,
        seed
      ),
      seed.hostId
    )
  } catch {
    // Renderer compensation already ran when available; session fallback is best-effort.
  }
  if (target && transfer.targetBefore) {
    try {
      operations.sessions.set(
        target.id,
        removeTransferredTerminalSession(
          operations.sessions.get(target.id, seed.hostId),
          transfer.targetBefore,
          seed
        ),
        seed.hostId
      )
    } catch {
      // Preserve the original transfer error.
    }
  }
  if (transfer.createdTarget && target && !target.isDestroyed()) {
    try {
      transfer.disposeTargetRenderer?.()
    } catch {
      // Target destruction remains the final cleanup attempt.
    }
    try {
      target.destroy()
    } catch {
      // Preserve the original transfer error.
    }
  }
}

export function installTerminalWindowTransferAbortListeners(
  operations: TerminalWindowTransferOperations,
  transfer: TerminalWindowTransfer
): void {
  const fail = (): void => {
    if (transfer.committed) {
      return
    }
    if (transfer.handedOff && transfer.targetRenderer) {
      try {
        operations.handoff(transfer.seed.ptyIds, transfer.targetRenderer, transfer.sourceRenderer)
        transfer.handedOff = false
      } catch {
        // Async rollback waits for a recovering source renderer if needed.
      }
    }
    transfer.abort(new Error('terminal_transfer_window_lost'))
  }
  transfer.fail = fail
  transfer.source.once('close', fail)
  transfer.sourceRenderer.once('render-process-gone', fail)
  transfer.target?.once('close', fail)
  transfer.targetRenderer?.once('render-process-gone', fail)
}

export function removeTerminalWindowTransferAbortListeners(transfer: TerminalWindowTransfer): void {
  const fail = transfer.fail
  if (!fail) {
    return
  }
  if (!transfer.source.isDestroyed()) {
    transfer.source.removeListener('close', fail)
  }
  transfer.sourceRenderer.removeListener('render-process-gone', fail)
  if (transfer.target && !transfer.target.isDestroyed()) {
    transfer.target.removeListener('close', fail)
  }
  transfer.targetRenderer?.removeListener('render-process-gone', fail)
}

export function finishCommittedTerminalWindowTransfer(
  transfer: TerminalWindowTransfer,
  sourceEmpty: boolean,
  isSourceSecondary: () => boolean,
  retireSource: () => void
): void {
  const { source, target } = transfer
  if (transfer.createdTarget && target && !target.isDestroyed()) {
    try {
      target.show()
    } catch {
      // The transfer is durable; revealing the window is best-effort.
    }
    try {
      target.focus()
    } catch {
      // The committed owner must not roll back on a focus failure.
    }
  }
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
