import type { EventEmitter } from 'node:events'
import {
  GRAB_EXECUTION_REQUEST,
  GRAB_EXECUTION_REPORT,
  type GrabExecutionRequest
} from '../../../../shared/browser/element-grab/grab-execution-protocol'

/** Only replaces the IPC transport; supplied guest script implementations produce the real result. */
export function attachGrabExecutionTransport<
  T extends EventEmitter & {
    executeJavaScript?: (code: string) => Promise<unknown>
    getURL?: () => string
    executeJavaScriptInIsolatedWorld?: (
      world: number,
      scripts: { code: string }[]
    ) => Promise<unknown>
  }
>(guest: T): T & { mainFrame: Electron.WebFrameMain; isLoadingMainFrame: () => boolean } {
  let documentId = 'fixture-document'
  guest.on('did-start-navigation', (_event, _url, inPlace, main) => {
    if (main && !inPlace) {
      documentId += '-next'
    }
  })
  const frame = {
    send: (channel: string, request: GrabExecutionRequest): void => {
      if (channel !== GRAB_EXECUTION_REQUEST) {
        return
      }
      const originalDocument = documentId
      queueMicrotask(async () => {
        if (request.kind === 'hello') {
          guest.emit('ipc-message', { senderFrame: frame }, GRAB_EXECUTION_REPORT, {
            id: request.id,
            documentId: originalDocument,
            ready: true
          })
          return
        }
        if (request.documentId !== documentId) {
          return
        }
        try {
          const value = await (request.worldId === 0
            ? guest.executeJavaScript?.(request.code)
            : guest.executeJavaScriptInIsolatedWorld?.(request.worldId, [{ code: request.code }]))
          guest.emit('ipc-message', { senderFrame: frame }, GRAB_EXECUTION_REPORT, {
            id: request.id,
            documentId: originalDocument,
            result: { ok: true, value }
          })
        } catch {
          guest.emit('ipc-message', { senderFrame: frame }, GRAB_EXECUTION_REPORT, {
            id: request.id,
            documentId: originalDocument,
            result: { ok: false }
          })
        }
      })
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the execution transport uses only frame.send and sender-frame object identity.
  const senderFrame = frame as unknown as Electron.WebFrameMain
  return Object.assign(guest, {
    mainFrame: senderFrame,
    isLoadingMainFrame: () => false,
    getURL: guest.getURL ?? (() => 'https://synthetic.invalid/')
  })
}
