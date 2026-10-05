import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { PtyRendererDelivery } from '../session'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { IPtyProvider } from '../../../providers/types'
import { isPtyWriteUnavailableError } from '../../../providers/pty-write-unavailable-error'
import {
  isTerminalInputTooLargeWithDeferredMeasurement,
  iterateTerminalInputChunks
} from '../../../../shared/terminal-input'
import { ptyOwnership } from '../provider/ownership-state'
import { tryGetProviderForPty } from '../provider/registry'
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'
import { interactiveOutputCharsByPty, lastInputAtByPty } from '../delivery/visibility-state'
import {
  NATIVE_CHAT_INPUT_ACTION_ID_MAX_LENGTH,
  type NativeChatInputWriteResult
} from '../../../../shared/native-chat-input-action'

export function isMainWindowPtyIpcEvent(
  event: IpcMainEvent | IpcMainInvokeEvent,
  mainWindow: PtyRendererDelivery | undefined
): boolean {
  const mainWebContents = mainWindow?.webContents
  return (
    !!mainWindow &&
    !!mainWebContents &&
    event.sender === mainWebContents &&
    !mainWindow.isDestroyed() &&
    !(typeof mainWebContents.isDestroyed === 'function' && mainWebContents.isDestroyed())
  )
}

export type PtyWritePayload = { id: string; data: string; inputKind: TerminalInputKind }
export type PtyChatInputPayload = PtyWritePayload & { actionId: string }
export type PtyViewportClaimPayload = { id: string; cols: number; rows: number }

export function createPtyWriteInput(deps: {
  mainWindow?: PtyRendererDelivery
  runtime?: OrcaRuntimeService
}): {
  writePtyInput: (args: PtyWritePayload) => boolean | Promise<boolean>
  writePtyInputAccepted: (args: PtyWritePayload) => boolean | Promise<boolean>
  writePtyChatInput: (
    args: PtyChatInputPayload,
    viewportClaim?: Promise<boolean>
  ) => Promise<NativeChatInputWriteResult>
  isPtyWritePayload: (value: unknown) => value is PtyWritePayload
  isPtyChatInputPayload: (value: unknown) => value is PtyChatInputPayload
  isPtyViewportClaimPayload: (value: unknown) => value is PtyViewportClaimPayload
  isPtyWriteEventFromMainWindow: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean
} {
  const { mainWindow, runtime } = deps

  const reportUnavailablePtyWrite = (id: string, error: unknown): void => {
    if (
      !isPtyWriteUnavailableError(error) ||
      !mainWindow ||
      mainWindow.isDestroyed() ||
      (typeof mainWindow.webContents.isDestroyed === 'function' &&
        mainWindow.webContents.isDestroyed())
    ) {
      return
    }
    mainWindow.webContents.send('pty:writeUnavailable', { id })
  }

  const writePtyProviderInputWithinLimit = (
    provider: IPtyProvider,
    id: string,
    data: string
  ): boolean | Promise<boolean> => {
    const chunks = iterateTerminalInputChunks(data)
    const first = chunks.next()
    if (first.done) {
      provider.write(id, data)
      return true
    }
    const second = chunks.next()
    if (second.done) {
      provider.write(id, first.value)
      return true
    }
    return writePtyProviderInputChunks(provider, id, chunks, first.value, second.value)
  }

  const writePtyProviderInput = (
    provider: IPtyProvider,
    id: string,
    data: string
  ): boolean | Promise<boolean> => {
    try {
      const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(data)
      if (typeof tooLarge === 'boolean') {
        return tooLarge ? false : writePtyProviderInputWithinLimit(provider, id, data)
      }
      return tooLarge
        .then((result) => {
          if (result) {
            return false
          }
          return writePtyProviderInputWithinLimit(provider, id, data)
        })
        .catch((error) => {
          reportUnavailablePtyWrite(id, error)
          return false
        })
    } catch (error) {
      reportUnavailablePtyWrite(id, error)
      return false
    }
  }

  const writePtyProviderInputChunks = async (
    provider: IPtyProvider,
    id: string,
    chunks: Iterator<string>,
    firstChunk: string,
    secondChunk: string
  ): Promise<boolean> => {
    try {
      let chunk: IteratorResult<string> = { done: false, value: firstChunk }
      let nextChunk: IteratorResult<string> = { done: false, value: secondChunk }
      while (!chunk.done) {
        provider.write(id, chunk.value)
        if (!nextChunk.done) {
          // setImmediate, not setTimeout(0): the yield exists to let abort/data callbacks run
          // between chunks, and a clamped timer tick per 16 KiB is pure latency.
          await new Promise((resolve) => setImmediate(resolve))
        }
        chunk = nextChunk
        nextChunk = chunks.next()
      }
      return true
    } catch (error) {
      reportUnavailablePtyWrite(id, error)
      return false
    }
  }

  const isPtyWritePayload = (value: unknown): value is PtyWritePayload =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    (value as { id: string }).id.length > 0 &&
    typeof (value as { data?: unknown }).data === 'string'

  const isPtyViewportClaimPayload = (value: unknown): value is PtyViewportClaimPayload =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    (value as { id: string }).id.length > 0 &&
    typeof (value as { cols?: unknown }).cols === 'number' &&
    Number.isFinite((value as { cols: number }).cols) &&
    typeof (value as { rows?: unknown }).rows === 'number' &&
    Number.isFinite((value as { rows: number }).rows) &&
    (value as { cols: number }).cols > 0 &&
    (value as { rows: number }).rows > 0

  const isPtyWriteEventFromMainWindow = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    isMainWindowPtyIpcEvent(event, mainWindow)

  const noteRendererPtyInput = (args: PtyWritePayload): void => {
    lastInputAtByPty.set(args.id, performance.now())
    interactiveOutputCharsByPty.set(args.id, 0)
    runtime?.terminalRunFacts?.recordInput(args.id, args.inputKind, args.data)
  }

  const writePtyInput = (args: PtyWritePayload): boolean | Promise<boolean> => {
    // Why: mobile-presence-lock defense-in-depth — the renderer's onData guard can let one keystroke slip during the state-flip lag, so catch it server-side. See docs/mobile-presence-lock.md.
    if (runtime?.getDriver(args.id).kind === 'mobile') {
      return false
    }
    const provider = ptyOwnership.has(args.id) ? tryGetProviderForPty(args.id) : undefined
    if (!provider) {
      return false
    }
    try {
      noteRendererPtyInput(args)
      return writePtyProviderInput(provider, args.id, args.data)
    } catch {
      return false
    }
  }

  const writePtyInputAccepted = (args: PtyWritePayload): boolean | Promise<boolean> => {
    if (runtime?.getDriver(args.id).kind === 'mobile') {
      return false
    }
    // Why: the ack infers Ctrl+C/Escape reached the local PTY; SSH providers are fire-and-forget relay notifications and can't truthfully acknowledge yet.
    if (ptyOwnership.get(args.id) !== null) {
      return false
    }
    const provider = tryGetProviderForPty(args.id)
    if (!provider?.hasPty?.(args.id)) {
      return false
    }
    try {
      noteRendererPtyInput(args)
      return writePtyProviderInput(provider, args.id, args.data)
    } catch {
      return false
    }
  }

  const isPtyChatInputPayload = (value: unknown): value is PtyChatInputPayload => {
    if (!isPtyWritePayload(value) || !('actionId' in value)) {
      return false
    }
    const { actionId } = value
    return (
      typeof actionId === 'string' &&
      actionId.length > 0 &&
      actionId.length <= NATIVE_CHAT_INPUT_ACTION_ID_MAX_LENGTH
    )
  }

  // Why not writePtyInputAccepted: that ack cannot settle SSH writes, and its callers fell back to
  // a raw write, which would type a refused chat message into a shell.
  const writePtyChatInput = async (
    args: PtyChatInputPayload,
    viewportClaim?: Promise<boolean>
  ): Promise<NativeChatInputWriteResult> => {
    if (!runtime || runtime.getDriver(args.id).kind === 'mobile') {
      return { accepted: false, bytesWritten: 0 }
    }
    try {
      // Why every wait inside: the action joins its PTY's chat order the moment it arrives.
      return await runtime.writeNativeChatInputToPty(
        args.id,
        args.data,
        args.inputKind,
        args.actionId,
        async () => {
          if (viewportClaim && !(await viewportClaim)) {
            return false
          }
          const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(args.data)
          if (typeof tooLarge === 'boolean' ? tooLarge : await tooLarge) {
            return false
          }
          lastInputAtByPty.set(args.id, performance.now())
          interactiveOutputCharsByPty.set(args.id, 0)
          return true
        }
      )
    } catch {
      return { accepted: false, bytesWritten: 0, deliveryUnknown: true }
    }
  }

  return {
    writePtyInput,
    writePtyInputAccepted,
    writePtyChatInput,
    isPtyChatInputPayload,
    isPtyWritePayload,
    isPtyViewportClaimPayload,
    isPtyWriteEventFromMainWindow
  }
}
