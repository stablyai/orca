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
import { interactiveOutputCharsByPty, lastInputAtByPty } from '../delivery/visibility-state'
import {
  isSettledWrite,
  writeRefused,
  type WriteSettlement
} from '../../../../shared/pty-write-settlement'
import { bindProviderPtyInput } from '../provider/input-binding'
import { isTerminalQueryReply } from '../../../../shared/terminal-query-reply'
import {
  ptyInputTransactions,
  type PtyInputTransaction
} from '../../../runtime/pty-input-transactions'

import {
  isMainWindowPtyIpcEvent,
  isPtyWritePayload,
  isPtyViewportClaimPayload,
  type PtyWritePayload,
  type PtyViewportClaimPayload
} from './write-input-validation'
export { isMainWindowPtyIpcEvent } from './write-input-validation'
export type { PtyWritePayload, PtyViewportClaimPayload } from './write-input-validation'

export function createPtyWriteInput(deps: {
  mainWindow?: PtyRendererDelivery
  runtime?: OrcaRuntimeService
}): {
  writePtyInput: (args: PtyWritePayload) => boolean | Promise<boolean>
  writePtyInputAccepted: (args: PtyWritePayload) => boolean | Promise<boolean>
  isPtyWritePayload: (value: unknown) => value is PtyWritePayload
  isPtyViewportClaimPayload: (value: unknown) => value is PtyViewportClaimPayload
  isPtyWriteEventFromMainWindow: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean
} {
  const { mainWindow, runtime } = deps

  const sendPtyWriteUnavailable = (id: string): void => {
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      (typeof mainWindow.webContents.isDestroyed === 'function' &&
        mainWindow.webContents.isDestroyed())
    ) {
      return
    }
    mainWindow.webContents.send('pty:writeUnavailable', { id })
  }

  const reportUnavailablePtyWrite = (id: string, error: unknown): void => {
    if (isPtyWriteUnavailableError(error)) {
      sendPtyWriteUnavailable(id)
    }
  }

  const writePtyProviderInputWithinLimit = (
    provider: IPtyProvider,
    id: string,
    data: string,
    verify: boolean,
    transaction?: PtyInputTransaction
  ): boolean | Promise<boolean> => {
    const chunks = iterateTerminalInputChunks(data)
    const first = chunks.next()
    if (first.done) {
      return writeChunk(provider, id, data, verify, transaction)
    }
    const second = chunks.next()
    if (second.done) {
      return writeChunk(provider, id, first.value, verify, transaction)
    }
    return writePtyProviderInputChunks(
      provider,
      id,
      chunks,
      first.value,
      second.value,
      verify,
      transaction
    )
  }

  const acceptedSettlement = (id: string, settlement: WriteSettlement): boolean => {
    if (settlement.outcome === 'unverifiable') {
      // A lost acknowledgment must not trigger a fallback write of the same bytes.
      throw new Error(`PTY write acknowledgment unavailable: ${settlement.reason}`)
    }
    if (settlement.outcome === 'refused' && settlement.reason === 'endpoint_awaiting_recovery') {
      // Settlement reports what a plain write would have thrown; the pane still needs to remount.
      sendPtyWriteUnavailable(id)
    }
    return settlement.outcome === 'accepted'
  }

  const writeChunk = (
    provider: IPtyProvider,
    id: string,
    data: string,
    verify: boolean,
    transaction?: PtyInputTransaction
  ): boolean | Promise<boolean> => {
    if (runtime?.getDriver(id).kind === 'mobile') {
      return false
    }
    if (!verify) {
      return transaction ? transaction.write(data, 'driving') : provider.write(id, data) !== false
    }
    const settlement = transaction
      ? transaction.writeWithSettlement(data, 'driving')
      : provider.writeWithSettlement(id, data)
    return isSettledWrite(settlement)
      ? acceptedSettlement(id, settlement)
      : settlement.then((settled) => acceptedSettlement(id, settled))
  }

  const failedWrite = (id: string, error: unknown, verify: boolean, noEffect = false): false => {
    reportUnavailablePtyWrite(id, error)
    if (verify && !noEffect && !isPtyWriteUnavailableError(error)) {
      throw error
    }
    return false
  }

  const writePtyProviderInput = (
    provider: IPtyProvider,
    id: string,
    data: string,
    verify: boolean,
    transaction?: PtyInputTransaction
  ): boolean | Promise<boolean> => {
    try {
      const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(data)
      if (typeof tooLarge === 'boolean') {
        return tooLarge
          ? false
          : writePtyProviderInputWithinLimit(provider, id, data, verify, transaction)
      }
      return tooLarge
        .then((result) => {
          if (result) {
            return false
          }
          return writePtyProviderInputWithinLimit(provider, id, data, verify, transaction)
        })
        .catch((error) => {
          return failedWrite(
            id,
            error,
            verify,
            !!transaction && !transaction.bytesHandedToTransport
          )
        })
    } catch (error) {
      return failedWrite(id, error, verify, !!transaction && !transaction.bytesHandedToTransport)
    }
  }

  const writePtyProviderInputChunks = async (
    provider: IPtyProvider,
    id: string,
    chunks: Iterator<string>,
    firstChunk: string,
    secondChunk: string,
    verify: boolean,
    transaction?: PtyInputTransaction
  ): Promise<boolean> => {
    try {
      let chunk: IteratorResult<string> = { done: false, value: firstChunk }
      let nextChunk: IteratorResult<string> = { done: false, value: secondChunk }
      let wroteChunk = false
      while (!chunk.done) {
        const accepted = writeChunk(provider, id, chunk.value, verify, transaction)
        if (!(typeof accepted === 'boolean' ? accepted : await accepted)) {
          if (wroteChunk) {
            // An accepted prefix is already in the PTY, so this is not a clean refusal.
            throw new Error('PTY write acknowledgment unavailable: partial_write')
          }
          return false
        }
        wroteChunk = true
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
      return failedWrite(id, error, verify, !!transaction && !transaction.bytesHandedToTransport)
    }
  }

  const isPtyWriteEventFromMainWindow = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    isMainWindowPtyIpcEvent(event, mainWindow)

  const noteRendererPtyInput = (args: PtyWritePayload): void => {
    lastInputAtByPty.set(args.id, performance.now())
    interactiveOutputCharsByPty.set(args.id, 0)
    runtime?.terminalRunFacts?.recordInput(args.id, args.inputKind, args.data)
  }

  const writeAndObserveInput = (
    provider: IPtyProvider,
    args: PtyWritePayload,
    verify = false
  ): boolean | Promise<boolean> => {
    const observe = (accepted: boolean): boolean => {
      if (accepted && args.inputKind === 'driving' && ptyOwnership.get(args.id) === null) {
        runtime?.observeClaudeTerminalEvidence?.(args.id, { kind: 'input', data: args.data })
      }
      return accepted
    }
    let inputTransaction: PtyInputTransaction | undefined
    const write = (transaction?: PtyInputTransaction): boolean | Promise<boolean> => {
      inputTransaction = transaction
      noteRendererPtyInput(args)
      const result = writePtyProviderInput(provider, args.id, args.data, verify, transaction)
      return typeof result === 'boolean' ? observe(result) : result.then(observe)
    }
    if (args.inputKind === 'query-reply' && isTerminalQueryReply(args.data)) {
      return write()
    }
    try {
      const result = ptyInputTransactions.run(bindProviderPtyInput(args.id), write, {
        interrupt: args.data === '\x03',
        rawInput: true,
        writer: {
          write: (data) => {
            if (runtime?.getDriver(args.id).kind === 'mobile') {
              return false
            }
            const currentProvider = tryGetProviderForPty(args.id)
            return !!currentProvider && currentProvider.write(args.id, data) !== false
          },
          writeWithSettlement: (data) => {
            if (runtime?.getDriver(args.id).kind === 'mobile') {
              return writeRefused('provider_refused_write')
            }
            return (
              tryGetProviderForPty(args.id)?.writeWithSettlement(args.id, data) ??
              writeRefused('provider_unavailable')
            )
          }
        }
      })
      return typeof result === 'boolean'
        ? result
        : result.catch((error) =>
            failedWrite(args.id, error, verify, !inputTransaction?.bytesHandedToTransport)
          )
    } catch (error) {
      return failedWrite(args.id, error, verify, !inputTransaction?.bytesHandedToTransport)
    }
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
      return writeAndObserveInput(provider, args)
    } catch {
      return false
    }
  }

  const writePtyInputSettled = (args: PtyWritePayload): boolean | Promise<boolean> => {
    if (!ptyOwnership.has(args.id)) {
      return false
    }
    const provider = tryGetProviderForPty(args.id)
    if (!provider?.hasPty?.(args.id)) {
      return false
    }
    return writeAndObserveInput(provider, args, true)
  }

  const writePtyInputAccepted = (args: PtyWritePayload): boolean | Promise<boolean> => {
    if (runtime?.getDriver(args.id).kind === 'mobile') {
      return false
    }
    if (args.requireWriteSettlement === true) {
      return writePtyInputSettled(args)
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
      return writeAndObserveInput(provider, args)
    } catch {
      return false
    }
  }

  return {
    writePtyInput,
    writePtyInputAccepted,
    isPtyWritePayload,
    isPtyViewportClaimPayload,
    isPtyWriteEventFromMainWindow
  }
}
