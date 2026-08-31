import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { IPtyProvider } from '../../../providers/types'
import { isPtyWriteUnavailableError } from '../../../providers/pty-write-unavailable-error'
import {
  agentSessionPtyWriteGate,
  type AgentSessionPtyWriteAdmittance
} from '../../../runtime/agent-session-pty-write-gate'
import {
  isTerminalInputTooLargeWithDeferredMeasurement,
  iterateTerminalInputChunks
} from '../../../../shared/terminal-input'
import { reportAgentSessionWriteRefusal } from '../agent-session-write-refusal-report'
import { ptyOwnership } from '../provider/ownership-state'
import { tryGetProviderForPty } from '../provider/registry'
import {
  interactiveOutputCharsByPty,
  lastInputAtByPty,
  visibleRendererPtys
} from '../delivery/visibility-state'

export function isMainWindowPtyIpcEvent(
  event: IpcMainEvent | IpcMainInvokeEvent,
  mainWindow: BrowserWindow,
  mainWebContents: WebContents
): boolean {
  return (
    event.sender === mainWebContents &&
    !mainWindow.isDestroyed() &&
    !(typeof mainWebContents.isDestroyed === 'function' && mainWebContents.isDestroyed())
  )
}

export type PtyWritePayload = { id: string; data: string }
export type PtyViewportClaimPayload = { id: string; cols: number; rows: number }

export function createPtyWriteInput(deps: {
  mainWindow: BrowserWindow
  runtime?: OrcaRuntimeService
  clearHiddenRendererResizeOutput: (id: string) => void
}): {
  writePtyInput: (args: PtyWritePayload) => boolean | Promise<boolean>
  writePtyInputAccepted: (args: PtyWritePayload) => boolean | Promise<boolean>
  isPtyWritePayload: (value: unknown) => value is PtyWritePayload
  isPtyViewportClaimPayload: (value: unknown) => value is PtyViewportClaimPayload
  isPtyWriteEventFromMainWindow: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    mainWebContents: WebContents
  ) => boolean
} {
  const { mainWindow, runtime, clearHiddenRendererResizeOutput } = deps

  const reportUnavailablePtyWrite = (id: string, error: unknown): void => {
    if (
      !isPtyWriteUnavailableError(error) ||
      mainWindow.isDestroyed() ||
      (typeof mainWindow.webContents.isDestroyed === 'function' &&
        mainWindow.webContents.isDestroyed())
    ) {
      return
    }
    mainWindow.webContents.send('pty:writeUnavailable', { id })
  }

  /** Single lease check for every byte-entry point this module owns. */
  const admitAgentSessionPtyWrite = (id: string): AgentSessionPtyWriteAdmittance | null => {
    const admission = agentSessionPtyWriteGate.admit(id)
    if (admission.admitted) {
      return { sessionId: admission.sessionId, runtimeFence: admission.runtimeFence }
    }
    reportAgentSessionWriteRefusal(mainWindow, id, admission.refusal)
    return null
  }

  /** Re-check after a yield: the lease can move to another owner between chunks. */
  const readmitAgentSessionPtyWrite = (
    id: string,
    admitted: AgentSessionPtyWriteAdmittance
  ): boolean => {
    const admission = agentSessionPtyWriteGate.readmit(id, admitted)
    if (admission.admitted) {
      return true
    }
    reportAgentSessionWriteRefusal(mainWindow, id, admission.refusal)
    return false
  }

  const writePtyProviderInputWithinLimit = (
    provider: IPtyProvider,
    id: string,
    data: string,
    admitted: AgentSessionPtyWriteAdmittance
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
    return writePtyProviderInputChunks(provider, id, chunks, first.value, second.value, admitted)
  }

  const writePtyProviderInput = (
    provider: IPtyProvider,
    id: string,
    data: string,
    admitted: AgentSessionPtyWriteAdmittance
  ): boolean | Promise<boolean> => {
    try {
      const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(data)
      if (typeof tooLarge === 'boolean') {
        return tooLarge ? false : writePtyProviderInputWithinLimit(provider, id, data, admitted)
      }
      return tooLarge
        .then((result) => {
          if (result || !readmitAgentSessionPtyWrite(id, admitted)) {
            return false
          }
          return writePtyProviderInputWithinLimit(provider, id, data, admitted)
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
    secondChunk: string,
    admitted: AgentSessionPtyWriteAdmittance
  ): Promise<boolean> => {
    try {
      let chunk: IteratorResult<string> = { done: false, value: firstChunk }
      let nextChunk: IteratorResult<string> = { done: false, value: secondChunk }
      let first = true
      while (!chunk.done) {
        if (!first && !readmitAgentSessionPtyWrite(id, admitted)) {
          return false
        }
        first = false
        provider.write(id, chunk.value)
        if (!nextChunk.done) {
          await new Promise((resolve) => setTimeout(resolve, 0))
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

  const isPtyWriteEventFromMainWindow = (
    event: IpcMainEvent | IpcMainInvokeEvent,
    mainWebContents: WebContents
  ): boolean => isMainWindowPtyIpcEvent(event, mainWindow, mainWebContents)

  const writePtyInput = (args: PtyWritePayload): boolean | Promise<boolean> => {
    // Why: mobile-presence-lock defense-in-depth — the renderer's onData guard can let one keystroke slip during the state-flip lag, so catch it server-side. See docs/mobile-presence-lock.md.
    if (runtime?.getDriver(args.id).kind === 'mobile') {
      return false
    }
    const admitted = admitAgentSessionPtyWrite(args.id)
    if (!admitted) {
      return false
    }
    const provider = ptyOwnership.has(args.id) ? tryGetProviderForPty(args.id) : undefined
    if (!provider) {
      return false
    }
    try {
      const now = performance.now()
      lastInputAtByPty.set(args.id, now)
      interactiveOutputCharsByPty.set(args.id, 0)
      if (visibleRendererPtys.has(args.id)) {
        clearHiddenRendererResizeOutput(args.id)
      }
      return writePtyProviderInput(provider, args.id, args.data, admitted)
    } catch {
      return false
    }
  }

  const writePtyInputAccepted = (args: PtyWritePayload): boolean | Promise<boolean> => {
    if (runtime?.getDriver(args.id).kind === 'mobile') {
      return false
    }
    const admitted = admitAgentSessionPtyWrite(args.id)
    if (!admitted) {
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
      const now = performance.now()
      lastInputAtByPty.set(args.id, now)
      interactiveOutputCharsByPty.set(args.id, 0)
      if (visibleRendererPtys.has(args.id)) {
        clearHiddenRendererResizeOutput(args.id)
      }
      return writePtyProviderInput(provider, args.id, args.data, admitted)
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
