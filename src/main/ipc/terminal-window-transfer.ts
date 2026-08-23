import { screen, type BrowserWindow, type WebContents } from 'electron'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type {
  TerminalWindowContext,
  TerminalWindowTransferResult
} from '../../shared/terminal-window-transfer'
import { getWorkspaceSessionPersistenceHostId } from '../../shared/workspace-session-persistence-host'
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
  createTerminalWindowTransfer,
  finishCommittedTerminalWindowTransfer,
  getTerminalWindowBounds,
  installTerminalWindowTransferAbortListeners,
  prepareTerminalWindowTargetRecord,
  revealCreatedTerminalWindowTarget,
  removeTerminalWindowTransferAbortListeners,
  isPointInsideRectangle,
  type TerminalWindowCommandReadyWaiter,
  type TerminalWindowTransfer,
  type TerminalWindowTransferOperations
} from './terminal-window-transfer-operation'
import {
  recoverTerminalTransferAfterSourceLoss,
  rollbackTerminalWindowTransfer
} from './terminal-window-transfer-recovery'
import {
  getTerminalWindowTransferSourceError,
  isTerminalWindowTransferSeed,
  sessionMatchesTerminalWindowTarget
} from './terminal-window-transfer-seed-validation'
import { sessionHasTerminalTransferBacking } from './terminal-window-transfer-session-patch'

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
  #fences = { handoff: false, quit: false }

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
    return {
      windowId: window.id,
      role,
      transitionFenced: this.#fences.handoff || this.#fences.quit
    }
  }

  async detach(event: RendererIpcEvent, input: unknown): Promise<TerminalWindowTransferResult> {
    const sender = this.#getTrustedSender(event)
    if (!sender) {
      return { ok: false, error: 'untrusted_ui_renderer' }
    }
    if (this.#fences.handoff || this.#fences.quit || this.#getIsQuitting()) {
      return { ok: false, error: 'window_transfer_fenced' }
    }
    if (!isTerminalWindowTransferSeed(input)) {
      return { ok: false, error: 'invalid_terminal_transfer_seed' }
    }
    const seed = structuredClone(input)
    const sessionPersistenceHostId = getWorkspaceSessionPersistenceHostId(seed.hostId)
    const source = this.#windows.getWindowForSender(sender)
    if (!source) {
      return { ok: false, error: 'untrusted_ui_renderer' }
    }
    if (this.#transfers.has(seed.tabId)) {
      return { ok: false, error: 'terminal_transfer_in_progress' }
    }
    const sourceBefore = this.#sessions.get(source.id, sessionPersistenceHostId)
    const sourceError = getTerminalWindowTransferSourceError(sourceBefore, seed, (id) =>
      this.#owners.owns(id, sender)
    )
    if (sourceError) {
      return { ok: false, error: sourceError }
    }

    const transfer = createTerminalWindowTransfer(seed, source, sender, sourceBefore)
    this.#transfers.set(seed.tabId, transfer)

    try {
      const point = this.#getCursorPoint()
      const sourceBounds = source.getBounds()
      if (isPointInsideRectangle(point, sourceBounds)) {
        throw new Error('terminal_transfer_pointer_inside_source')
      }
      let target = this.#windows.getWindowAtPoint(point, source.id)
      if (target) {
        const state = this.#sessions.get(target.id, sessionPersistenceHostId)
        if (
          !sessionMatchesTerminalWindowTarget(state, seed) ||
          sessionHasTerminalTransferBacking(state, seed.tabId, seed.ptyIds)
        ) {
          throw new Error('terminal_transfer_target_mismatch')
        }
        transfer.targetBefore = state
      } else {
        target = this.#createSecondaryWindow(
          getTerminalWindowBounds(point, this.#getWorkArea(point))
        )
        transfer.target = target
        transfer.createdTarget = true
        transfer.targetRenderer = target.webContents
        transfer.targetBefore = getDefaultWorkspaceSession()
        transfer.disposeTargetRenderer = () => {
          this.#owners.removeRenderer(transfer.targetRenderer!)
        }
        const dispose = this.#registerRenderer(transfer.targetRenderer)
        transfer.disposeTargetRenderer = () => {
          try {
            dispose()
          } finally {
            this.#owners.removeRenderer(transfer.targetRenderer!)
          }
        }
        this.#sessions.seedWindow(
          target.id,
          new Map([
            ['local', getDefaultWorkspaceSession()],
            [sessionPersistenceHostId, getDefaultWorkspaceSession()]
          ])
        )
      }
      transfer.target = target
      transfer.targetRenderer ??= target.webContents
      installTerminalWindowTransferAbortListeners(this.#operations, transfer)
      const targetCurrent = this.#sessions.get(target.id, sessionPersistenceHostId)
      if (
        (!transfer.createdTarget && !sessionMatchesTerminalWindowTarget(targetCurrent, seed)) ||
        sessionHasTerminalTransferBacking(targetCurrent, seed.tabId, seed.ptyIds)
      ) {
        throw new Error('terminal_transfer_target_mismatch')
      }
      transfer.targetBefore = targetCurrent
      transfer.prepared = true
      this.#sessions.set(
        target.id,
        prepareTerminalWindowTargetRecord(targetCurrent, seed),
        sessionPersistenceHostId
      )
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
      transfer.targetImported = true
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
        () => this.#sessions.isWindowEmptyAcrossHosts(source.id),
        () => this.#sessions.retire(source.id, 'empty-close')
      )
      return { ok: true, targetWindowId: target.id }
    } catch (error) {
      const recovery = await recoverTerminalTransferAfterSourceLoss(this.#operations, transfer)
      if (recovery === 'committed') {
        revealCreatedTerminalWindowTarget(transfer)
        return { ok: true, targetWindowId: transfer.target!.id }
      }
      if (recovery === 'failed') {
        revealCreatedTerminalWindowTarget(transfer)
        return { ok: false, error: 'terminal_transfer_target_recovery_failed' }
      }
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
    this.#fences.quit = true
    return this.#fenceTransfers('terminal_transfer_quit')
  }

  fenceForControlHandoff(): Promise<void> {
    this.#fences.handoff = true
    return this.#fenceTransfers('terminal_transfer_control_handoff')
  }

  #fenceTransfers(reason: string): Promise<void> {
    const transfers = [...this.#transfers.values()]
    for (const transfer of transfers) {
      transfer.abort(new Error(reason))
    }
    return Promise.all(transfers.map((transfer) => transfer.finished)).then(() => undefined)
  }

  resumeAfterQuitAbort(): void {
    this.#fences.quit = false
  }

  resumeAfterControlHandoff(): void {
    this.#fences.handoff = false
  }
}
