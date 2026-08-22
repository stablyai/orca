import { randomUUID } from 'node:crypto'
import { ipcMain, screen, type BrowserWindow, type IpcMainEvent, type WebContents } from 'electron'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type {
  TerminalWindowContext,
  TerminalWindowTransferResult
} from '../../shared/terminal-window-transfer'
import { getWindowSessionRegistry } from '../persistence/window-session-registry'
import { loadMainWindow } from '../window/createMainWindow'
import { orcaWindowManager } from '../window/orca-window-manager'
import { handoffPtyRendererOwnership, registerPtyRenderer, sendToPtyOwner } from './pty'
import { ptyRendererOwners } from './pty-renderer-owners'
import { isCurrentRendererMainFrame, type RendererIpcEvent } from './renderer-ipc-frame-trust'
import type { TerminalWindowTransferCoordinatorOptions } from './terminal-window-transfer-coordinator-options'
import {
  clearTerminalWindowTransferWaiters,
  markTerminalWindowCommandReady,
  sendTerminalWindowTransferCommand,
  settleTerminalWindowTransferAck,
  waitUntilTerminalWindowCommandReady
} from './terminal-window-transfer-command'
import {
  finishCommittedTerminalWindowTransfer,
  getTerminalWindowTransferSourceError,
  getTerminalWindowBounds,
  installTerminalWindowTransferAbortListeners,
  prepareTerminalWindowTargetRecord,
  removeTerminalWindowTransferAbortListeners,
  rollbackTerminalWindowTransfer,
  sessionHasTerminalTab,
  sessionMatchesTerminalWindowTarget,
  isPointInsideRectangle,
  type TerminalWindowCommandReadyWaiter,
  type TerminalWindowTransfer,
  type TerminalWindowTransferOperations
} from './terminal-window-transfer-operation'
import { isTerminalWindowTransferSeed } from './terminal-window-transfer-seed-validation'

export const TERMINAL_WINDOW_TRANSFER_ACK_TIMEOUT_MS = 10_000

export class TerminalWindowTransferCoordinator {
  readonly #createSecondaryWindow: (bounds: Electron.Rectangle) => BrowserWindow
  readonly #getIsQuitting: () => boolean
  readonly #windows: NonNullable<TerminalWindowTransferCoordinatorOptions['windows']>
  readonly #sessions: NonNullable<TerminalWindowTransferCoordinatorOptions['sessions']>
  readonly #owners: NonNullable<TerminalWindowTransferCoordinatorOptions['owners']>
  readonly #getCursorPoint: () => Electron.Point
  readonly #getWorkArea: (point: Electron.Point) => Electron.Rectangle
  readonly #loadWindow: (window: BrowserWindow) => void
  readonly #registerRenderer: (webContents: WebContents) => () => void
  readonly #handoff: (ptyIds: readonly string[], from: WebContents, to: WebContents) => void
  readonly #timeoutMs: number
  readonly #transfers = new Map<string, TerminalWindowTransfer>()
  readonly #operations: TerminalWindowTransferOperations
  readonly #commandReady = new Set<WebContents>()
  readonly #commandReadyWaiters = new Map<WebContents, Set<TerminalWindowCommandReadyWaiter>>()
  readonly #trackedRenderers = new Set<WebContents>()
  #fenced = false

  constructor(options: TerminalWindowTransferCoordinatorOptions) {
    this.#createSecondaryWindow = options.createSecondaryWindow
    this.#getIsQuitting = options.getIsQuitting ?? (() => false)
    this.#windows = options.windows ?? orcaWindowManager
    this.#sessions = options.sessions ?? getWindowSessionRegistry(options.store)
    this.#owners = options.owners ?? ptyRendererOwners
    this.#getCursorPoint = options.getCursorPoint ?? (() => screen.getCursorScreenPoint())
    this.#getWorkArea =
      options.getWorkArea ?? ((point) => screen.getDisplayNearestPoint(point).workArea)
    this.#loadWindow = options.loadWindow ?? loadMainWindow
    this.#registerRenderer = options.registerRenderer ?? registerPtyRenderer
    this.#handoff = options.handoff ?? handoffPtyRendererOwnership
    this.#timeoutMs = options.timeoutMs ?? TERMINAL_WINDOW_TRANSFER_ACK_TIMEOUT_MS
    this.#operations = {
      sessions: this.#sessions,
      owners: this.#owners,
      handoff: this.#handoff,
      timeoutMs: this.#timeoutMs
    }
  }

  #getTrustedSender(event: RendererIpcEvent): WebContents | null {
    const sender = event.sender
    return isCurrentRendererMainFrame(event) &&
      this.#windows.getWindowForSender(sender) &&
      this.#owners.isRegistered(sender)
      ? sender
      : null
  }

  getContext(event: RendererIpcEvent): TerminalWindowContext {
    const sender = this.#getTrustedSender(event)
    if (!sender) {
      throw new Error('untrusted_ui_renderer')
    }
    const window = this.#windows.getWindowForSender(sender)
    const role = window ? this.#windows.getRole(window.id) : null
    if (!window || !role) {
      throw new Error('untrusted_ui_renderer')
    }
    markTerminalWindowCommandReady(
      this.#commandReady,
      this.#commandReadyWaiters,
      this.#trackedRenderers,
      sender
    )
    return { windowId: window.id, role, transitionFenced: this.#fenced }
  }

  async detach(event: RendererIpcEvent, input: unknown): Promise<TerminalWindowTransferResult> {
    const sender = this.#getTrustedSender(event)
    if (!sender) {
      return { ok: false, error: 'untrusted_ui_renderer' }
    }
    if (this.#fenced || this.#getIsQuitting()) {
      return { ok: false, error: 'window_transfer_fenced' }
    }
    if (!isTerminalWindowTransferSeed(input)) {
      return { ok: false, error: 'invalid_terminal_transfer_seed' }
    }
    const seed = structuredClone(input)
    const source = this.#windows.getWindowForSender(sender)
    if (!source) {
      return { ok: false, error: 'untrusted_ui_renderer' }
    }
    if (this.#transfers.has(seed.tabId)) {
      return { ok: false, error: 'terminal_transfer_in_progress' }
    }
    const sourceBefore = this.#sessions.get(source.id, seed.hostId)
    const sourceError = getTerminalWindowTransferSourceError(sourceBefore, seed, (id) =>
      this.#owners.owns(id, sender)
    )
    if (sourceError) {
      return { ok: false, error: sourceError }
    }

    let abort!: (error: Error) => void
    let finish!: () => void
    const transfer: TerminalWindowTransfer = {
      transferId: randomUUID(),
      seed,
      source,
      sourceRenderer: sender,
      target: null,
      targetRenderer: null,
      sourceBefore,
      targetBefore: null,
      createdTarget: false,
      prepared: false,
      handedOff: false,
      targetImportAttempted: false,
      sourceRemoveAttempted: false,
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
    this.#transfers.set(seed.tabId, transfer)

    try {
      const point = this.#getCursorPoint()
      const sourceBounds = source.getBounds()
      if (isPointInsideRectangle(point, sourceBounds)) {
        throw new Error('terminal_transfer_pointer_inside_source')
      }
      let target = this.#windows.getWindowAtPoint(point, source.id)
      if (target) {
        const state = this.#sessions.get(target.id, seed.hostId)
        if (
          !sessionMatchesTerminalWindowTarget(state, seed) ||
          sessionHasTerminalTab(state, seed.tabId)
        ) {
          throw new Error('terminal_transfer_target_mismatch')
        }
        transfer.targetBefore = state
      } else {
        target = this.#createSecondaryWindow(
          getTerminalWindowBounds(point, this.#getWorkArea(point))
        )
        transfer.createdTarget = true
        transfer.targetBefore = getDefaultWorkspaceSession()
        transfer.disposeTargetRenderer = this.#registerRenderer(target.webContents)
        this.#sessions.seedWindow(
          target.id,
          new Map([
            ['local', getDefaultWorkspaceSession()],
            [seed.hostId, getDefaultWorkspaceSession()]
          ])
        )
      }
      transfer.target = target
      transfer.targetRenderer = target.webContents
      installTerminalWindowTransferAbortListeners(this.#operations, transfer)
      this.#sessions.set(
        target.id,
        prepareTerminalWindowTargetRecord(transfer.targetBefore, seed),
        seed.hostId
      )
      transfer.prepared = true
      if (transfer.createdTarget) {
        this.#loadWindow(target)
      }
      await Promise.race([
        Promise.all([
          this.#owners.waitUntilDispatcherReady(transfer.targetRenderer, this.#timeoutMs),
          waitUntilTerminalWindowCommandReady(
            this.#commandReady,
            this.#commandReadyWaiters,
            transfer.targetRenderer,
            this.#timeoutMs
          )
        ]),
        transfer.aborted
      ])
      this.#handoff(seed.ptyIds, sender, transfer.targetRenderer)
      transfer.handedOff = true

      transfer.targetImportAttempted = true
      await sendTerminalWindowTransferCommand(this.#operations, transfer, transfer.targetRenderer, {
        transferId: transfer.transferId,
        tabId: seed.tabId,
        phase: 'target-import',
        seed
      })
      for (const id of seed.ptyIds) {
        sendToPtyOwner(id, 'pty:modelRestoreNeeded', { id, reason: 'delivery-heal' })
      }
      transfer.sourceRemoveAttempted = true
      const sourceAck = await sendTerminalWindowTransferCommand(
        this.#operations,
        transfer,
        sender,
        {
          transferId: transfer.transferId,
          tabId: seed.tabId,
          phase: 'source-remove'
        }
      )
      transfer.committed = true
      transfer.handedOff = false
      finishCommittedTerminalWindowTransfer(
        transfer,
        sourceAck.empty === true,
        () => this.#windows.getRole(source.id) === 'secondary',
        () => this.#sessions.retire(source.id, 'empty-close')
      )
      return { ok: true, targetWindowId: target.id }
    } catch (error) {
      await rollbackTerminalWindowTransfer(this.#operations, transfer)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      clearTerminalWindowTransferWaiters(transfer)
      removeTerminalWindowTransferAbortListeners(transfer)
      this.#transfers.delete(seed.tabId)
      transfer.finish()
    }
  }

  acknowledge(event: RendererIpcEvent, input: unknown): void {
    const sender = this.#getTrustedSender(event)
    if (sender) {
      settleTerminalWindowTransferAck(this.#transfers, sender, input)
    }
  }

  fenceForQuit(): Promise<void> {
    this.#fenced = true
    const transfers = [...this.#transfers.values()]
    for (const transfer of transfers) {
      transfer.abort(new Error('terminal_transfer_quit'))
    }
    return Promise.all(transfers.map((transfer) => transfer.finished)).then(() => undefined)
  }

  resumeAfterQuitAbort(): void {
    this.#fenced = false
  }
}

export function registerTerminalWindowTransferHandlers(
  options: TerminalWindowTransferCoordinatorOptions
): TerminalWindowTransferCoordinator {
  const coordinator = new TerminalWindowTransferCoordinator(options)
  ipcMain.removeHandler('terminalWindow:detach')
  ipcMain.removeHandler('terminalWindow:getContext')
  ipcMain.removeAllListeners('terminalWindow:ack')
  ipcMain.handle('terminalWindow:detach', (event, seed) => coordinator.detach(event, seed))
  ipcMain.handle('terminalWindow:getContext', (event) => coordinator.getContext(event))
  ipcMain.on('terminalWindow:ack', (event: IpcMainEvent, ack: unknown) => {
    coordinator.acknowledge(event, ack)
  })
  return coordinator
}
