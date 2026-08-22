import type { WebContents } from 'electron'
import {
  isTerminalWindowTransferAck,
  type TerminalWindowTransferAck,
  type TerminalWindowTransferCommand
} from '../../shared/terminal-window-transfer'
import type {
  TerminalWindowCommandReadyWaiter,
  TerminalWindowTransfer,
  TerminalWindowTransferCommandWaiter,
  TerminalWindowTransferOperations
} from './terminal-window-transfer-operation'

export function markTerminalWindowCommandReady(
  readyRenderers: Set<WebContents>,
  waitersByRenderer: Map<WebContents, Set<TerminalWindowCommandReadyWaiter>>,
  trackedRenderers: Set<WebContents>,
  sender: WebContents
): void {
  if (!trackedRenderers.has(sender)) {
    trackedRenderers.add(sender)
    const loading = (): void => {
      readyRenderers.delete(sender)
    }
    sender.on('did-start-loading', loading)
    sender.once('destroyed', () => {
      sender.removeListener('did-start-loading', loading)
      trackedRenderers.delete(sender)
      readyRenderers.delete(sender)
      const waiters = waitersByRenderer.get(sender)
      waitersByRenderer.delete(sender)
      for (const waiter of waiters ?? []) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('terminal_transfer_renderer_destroyed'))
      }
    })
  }
  readyRenderers.add(sender)
  for (const waiter of waitersByRenderer.get(sender) ?? []) {
    clearTimeout(waiter.timer)
    waiter.resolve()
  }
  waitersByRenderer.delete(sender)
}

export function waitUntilTerminalWindowCommandReady(
  readyRenderers: ReadonlySet<WebContents>,
  waitersByRenderer: Map<WebContents, Set<TerminalWindowCommandReadyWaiter>>,
  sender: WebContents,
  timeoutMs: number
): Promise<void> {
  if (readyRenderers.has(sender)) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const waiter: TerminalWindowCommandReadyWaiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const waiters = waitersByRenderer.get(sender)
        waiters?.delete(waiter)
        if (waiters?.size === 0) {
          waitersByRenderer.delete(sender)
        }
        reject(new Error('terminal_window_renderer_ready_timeout'))
      }, timeoutMs)
    }
    const waiters = waitersByRenderer.get(sender) ?? new Set<TerminalWindowCommandReadyWaiter>()
    waiters.add(waiter)
    waitersByRenderer.set(sender, waiters)
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
  let waiter!: TerminalWindowTransferCommandWaiter
  const response = new Promise<TerminalWindowTransferAck>((resolve, reject) => {
    waiter = {
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
  try {
    sender.send('terminalWindow:command', command)
  } catch (error) {
    transfer.waiters.delete(command.phase)
    clearTimeout(waiter.timer)
    waiter.reject(error instanceof Error ? error : new Error(String(error)))
  }
  return ignoreAbort ? response : Promise.race([response, transfer.aborted])
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
