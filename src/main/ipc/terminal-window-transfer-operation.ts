import type { BrowserWindow, WebContents } from 'electron'
import { LOCAL_EXECUTION_HOST_ID, normalizeExecutionHostId } from '../../shared/execution-host'
import { isWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
import {
  isTerminalWindowTransferAck,
  type TerminalWindowTransferAck,
  type TerminalWindowTransferCommand,
  type TerminalWindowTransferPhase,
  type TerminalWindowTransferSeed
} from '../../shared/terminal-window-transfer'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WindowSessionRegistry } from '../persistence/window-session-registry'
import { sendToPtyOwner } from './pty'
import type { PtyRendererOwners } from './pty-renderer-owners'

type CommandWaiter = {
  sender: WebContents
  resolve: (ack: TerminalWindowTransferAck) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type TerminalWindowTransfer = {
  transferId: string
  seed: TerminalWindowTransferSeed
  source: BrowserWindow
  target: BrowserWindow | null
  sourceBefore: WorkspaceSessionState
  targetBefore: WorkspaceSessionState | null
  createdTarget: boolean
  prepared: boolean
  handedOff: boolean
  targetImportAttempted: boolean
  sourceRemoveAttempted: boolean
  committed: boolean
  waiters: Map<TerminalWindowTransferPhase, CommandWaiter>
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

export function isTerminalWindowTransferSeed(value: unknown): value is TerminalWindowTransferSeed {
  const seed = value as Partial<TerminalWindowTransferSeed> | null
  return Boolean(
    seed &&
    typeof seed.tabId === 'string' &&
    seed.tabId.length > 0 &&
    normalizeExecutionHostId(seed.hostId) === seed.hostId &&
    typeof seed.canonicalWorkspaceKey === 'string' &&
    isWorkspaceKey(seed.canonicalWorkspaceKey) &&
    typeof seed.worktreeId === 'string' &&
    seed.worktreeId.length > 0 &&
    seed.tab?.id === seed.tabId &&
    seed.tab.worktreeId === seed.worktreeId &&
    seed.group &&
    typeof seed.group.id === 'string' &&
    seed.layout &&
    typeof seed.layout === 'object' &&
    Array.isArray(seed.ptyIds) &&
    seed.ptyIds.length > 0 &&
    seed.ptyIds.every((id) => typeof id === 'string' && id.length > 0) &&
    seed.repo &&
    typeof seed.repo.id === 'string'
  )
}

export function sessionHasTerminalTab(state: WorkspaceSessionState, tabId: string): boolean {
  return Object.values(state.tabsByWorktree).some((tabs) => tabs.some((tab) => tab.id === tabId))
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

export function waitUntilTerminalWindowCommandReady(
  readyRenderers: ReadonlySet<number>,
  waitersByRenderer: Map<number, Set<() => void>>,
  sender: WebContents,
  timeoutMs: number
): Promise<void> {
  if (readyRenderers.has(sender.id)) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const ready = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      waitersByRenderer.get(sender.id)?.delete(ready)
      reject(new Error('terminal_window_renderer_ready_timeout'))
    }, timeoutMs)
    const waiters = waitersByRenderer.get(sender.id) ?? new Set<() => void>()
    waiters.add(ready)
    waitersByRenderer.set(sender.id, waiters)
  })
}

export function sendTerminalWindowTransferCommand(
  operations: TerminalWindowTransferOperations,
  transfer: TerminalWindowTransfer,
  sender: WebContents,
  command: TerminalWindowTransferCommand,
  ignoreAbort = false
): Promise<TerminalWindowTransferAck> {
  if (sender.isDestroyed()) {
    return Promise.reject(new Error('terminal_transfer_renderer_destroyed'))
  }
  const response = new Promise<TerminalWindowTransferAck>((resolve, reject) => {
    const waiter: CommandWaiter = {
      sender,
      resolve,
      reject,
      timer: setTimeout(() => {
        transfer.waiters.delete(command.phase)
        reject(new Error(`terminal_transfer_${command.phase}_timeout`))
      }, operations.timeoutMs)
    }
    transfer.waiters.set(command.phase, waiter)
  })
  sender.send('terminalWindow:command', command)
  return ignoreAbort ? response : Promise.race([response, transfer.aborted])
}

export async function rollbackTerminalWindowTransfer(
  operations: TerminalWindowTransferOperations,
  transfer: TerminalWindowTransfer
): Promise<void> {
  if (!transfer.prepared || transfer.committed) {
    return
  }
  const { source, target, seed } = transfer
  if (transfer.handedOff && target) {
    try {
      operations.handoff(seed.ptyIds, target.webContents, source.webContents)
      transfer.handedOff = false
    } catch {
      try {
        await operations.owners.waitUntilDispatcherReady(source.webContents, operations.timeoutMs)
        operations.handoff(seed.ptyIds, target.webContents, source.webContents)
        transfer.handedOff = false
      } catch {
        // Keep the PTY with its last live owner; record snapshots still prevent durable loss.
      }
    }
  }
  const commands: Promise<unknown>[] = []
  if (transfer.targetImportAttempted && target && !target.webContents.isDestroyed()) {
    commands.push(
      sendTerminalWindowTransferCommand(
        operations,
        transfer,
        target.webContents,
        { transferId: transfer.transferId, tabId: seed.tabId, phase: 'target-remove' },
        true
      ).catch(() => undefined)
    )
  }
  if (transfer.sourceRemoveAttempted && !source.webContents.isDestroyed()) {
    commands.push(
      sendTerminalWindowTransferCommand(
        operations,
        transfer,
        source.webContents,
        { transferId: transfer.transferId, tabId: seed.tabId, phase: 'source-restore', seed },
        true
      ).catch(() => undefined)
    )
  }
  await Promise.all(commands)
  if (seed.ptyIds.every((id) => operations.owners.owns(id, source.webContents))) {
    for (const id of seed.ptyIds) {
      sendToPtyOwner(id, 'pty:modelRestoreNeeded', { id, reason: 'delivery-heal' })
    }
  }
  operations.sessions.set(source.id, transfer.sourceBefore, seed.hostId)
  if (target && transfer.targetBefore) {
    operations.sessions.set(target.id, transfer.targetBefore, seed.hostId)
  }
  if (transfer.createdTarget && target && !target.isDestroyed()) {
    transfer.disposeTargetRenderer?.()
    target.destroy()
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
    if (transfer.handedOff && transfer.target) {
      try {
        operations.handoff(
          transfer.seed.ptyIds,
          transfer.target.webContents,
          transfer.source.webContents
        )
        transfer.handedOff = false
      } catch {
        // Async rollback waits for a recovering source renderer if needed.
      }
    }
    transfer.abort(new Error('terminal_transfer_window_lost'))
  }
  transfer.fail = fail
  transfer.source.once('close', fail)
  transfer.source.webContents.once('render-process-gone', fail)
  transfer.target?.once('close', fail)
  transfer.target?.webContents.once('render-process-gone', fail)
}

export function removeTerminalWindowTransferAbortListeners(transfer: TerminalWindowTransfer): void {
  const fail = transfer.fail
  if (!fail) {
    return
  }
  if (!transfer.source.isDestroyed()) {
    transfer.source.removeListener('close', fail)
    transfer.source.webContents.removeListener('render-process-gone', fail)
  }
  if (transfer.target && !transfer.target.isDestroyed()) {
    transfer.target.removeListener('close', fail)
    transfer.target.webContents.removeListener('render-process-gone', fail)
  }
}

export function clearTerminalWindowTransferWaiters(transfer: TerminalWindowTransfer): void {
  for (const waiter of transfer.waiters.values()) {
    clearTimeout(waiter.timer)
    waiter.reject(new Error('terminal_transfer_finished'))
  }
  transfer.waiters.clear()
}

export function settleTerminalWindowTransferAck(
  transfers: ReadonlyMap<string, TerminalWindowTransfer>,
  sender: WebContents,
  input: unknown
): void {
  if (!isTerminalWindowTransferAck(input)) {
    return
  }
  const transfer = transfers.get(input.tabId)
  const waiter = transfer?.waiters.get(input.phase)
  if (
    !transfer ||
    transfer.transferId !== input.transferId ||
    !waiter ||
    waiter.sender !== sender
  ) {
    return
  }
  transfer.waiters.delete(input.phase)
  clearTimeout(waiter.timer)
  if (input.ok) {
    waiter.resolve(input)
  } else {
    waiter.reject(new Error(input.error || `terminal_transfer_${input.phase}_failed`))
  }
}
