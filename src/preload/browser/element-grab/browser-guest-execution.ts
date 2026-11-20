import type { WebFrame } from 'electron'
import {
  GRAB_EXECUTION_REQUEST,
  GRAB_EXECUTION_REPORT,
  type GrabExecutionRequest,
  type GrabExecutionResult
} from '../../../shared/browser/element-grab/grab-execution-protocol'

/** Private document-scoped transport; no per-invocation Electron main reply listener survives navigation. */
export function installBrowserGuestExecution(
  port: {
    on: (channel: string, listener: (payload: GrabExecutionRequest) => void) => void
    send: (channel: string, payload: unknown) => void
  },
  frame: Pick<WebFrame, 'executeJavaScript' | 'executeJavaScriptInIsolatedWorld'>
): void {
  const documentId = Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-')
  const occupied = new Set<string>()
  port.on(GRAB_EXECUTION_REQUEST, (request) => {
    if (request.kind === 'hello') {
      port.send(GRAB_EXECUTION_REPORT, { id: request.id, documentId, ready: true })
      return
    }
    if (request.documentId !== documentId) {
      return
    }
    const answer = (result: GrabExecutionResult): void => {
      port.send(GRAB_EXECUTION_REPORT, { id: request.id, documentId, result })
    }
    if (Date.now() > request.expiresAt || occupied.has(request.lane)) {
      answer({ ok: false })
      return
    }
    occupied.add(request.lane)
    void (async () => {
      try {
        const value = await (request.worldId === 0
          ? frame.executeJavaScript(request.code)
          : frame.executeJavaScriptInIsolatedWorld(request.worldId, [{ code: request.code }]))
        answer({ ok: true, value })
      } catch {
        answer({ ok: false })
      } finally {
        occupied.delete(request.lane)
      }
    })()
  })
}
