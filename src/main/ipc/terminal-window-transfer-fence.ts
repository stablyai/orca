import type { TerminalWindowTransfer } from './terminal-window-transfer-operation'

export class TerminalWindowTransferFence {
  readonly #getTransfers: () => Iterable<TerminalWindowTransfer>
  readonly #closingWindowIds = new Set<number>()
  #handoff = false
  #quit = false

  constructor(getTransfers: () => Iterable<TerminalWindowTransfer>) {
    this.#getTransfers = getTransfers
  }

  isGloballyFenced(): boolean {
    return this.#handoff || this.#quit
  }

  isWindowFenced(windowId: number): boolean {
    return this.#closingWindowIds.has(windowId)
  }

  readonly fenceForQuit = (): Promise<void> => {
    this.#quit = true
    return this.#fence('terminal_transfer_quit')
  }

  readonly fenceForControlHandoff = (): Promise<void> => {
    this.#handoff = true
    return this.#fence('terminal_transfer_control_handoff')
  }

  readonly fenceForWindowClose = (windowId: number): Promise<void> => {
    this.#closingWindowIds.add(windowId)
    return this.#fence(
      'terminal_transfer_window_close',
      (transfer) => transfer.source.id === windowId || transfer.target?.id === windowId
    )
  }

  readonly hasPendingTransferForWindow = (windowId: number): boolean =>
    [...this.#getTransfers()].some(
      (transfer) => transfer.source.id === windowId || transfer.target?.id === windowId
    )

  readonly resumeAfterWindowClose = (windowId: number): void => {
    this.#closingWindowIds.delete(windowId)
  }

  readonly resumeAfterQuitAbort = (): void => {
    this.#quit = false
  }

  readonly resumeAfterControlHandoff = (): void => {
    this.#handoff = false
  }

  #fence(
    reason: string,
    matches: (transfer: TerminalWindowTransfer) => boolean = () => true
  ): Promise<void> {
    const transfers = [...this.#getTransfers()].filter(matches)
    for (const transfer of transfers) {
      transfer.abort(new Error(reason))
    }
    return Promise.all(transfers.map((transfer) => transfer.finished)).then(() => undefined)
  }
}
