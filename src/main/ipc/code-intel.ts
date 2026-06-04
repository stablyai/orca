import { ipcMain } from 'electron'
import type { CodeIntelRequest, CodeIntelResult } from '../../shared/code-intel-contract'
import { getCodeIntelSidecar } from '../code-intel/sidecar-client'
import type { SidecarMethod } from '../code-intel/sidecar-protocol'

export type CodeIntelIpcArgs = CodeIntelRequest & { connectionId?: string; requestId?: number }

// Why: AbortSignal cannot cross IPC, so the renderer cancels by re-sending the
// request id it generated. We hold one controller per in-flight (sender, id)
// pair and abort it on that signal, which propagates cancellation to the sidecar.
const controllers = new Map<string, AbortController>()

function controllerKey(senderId: number, requestId: number): string {
  return `${senderId}:${requestId}`
}

export async function handleCodeIntelQuery(
  method: SidecarMethod,
  args: CodeIntelIpcArgs,
  senderId = 0
): Promise<CodeIntelResult> {
  if (args.connectionId) {
    return { status: 'unsupported', reason: 'remote-runtime' }
  }
  const { connectionId: _connectionId, requestId, ...request } = args
  const sidecar = getCodeIntelSidecar()
  if (requestId === undefined) {
    return sidecar.query(method, request)
  }
  const key = controllerKey(senderId, requestId)
  const controller = new AbortController()
  controllers.set(key, controller)
  try {
    return await sidecar.query(method, request, controller.signal)
  } catch (error) {
    if (controller.signal.aborted) {
      return { status: 'error', code: 'cancelled', message: 'request cancelled' }
    }
    throw error
  } finally {
    controllers.delete(key)
  }
}

export function cancelCodeIntelQuery(senderId: number, requestId: number): void {
  controllers.get(controllerKey(senderId, requestId))?.abort()
}

export function registerCodeIntelHandlers(): void {
  ipcMain.handle('codeIntel:definition', (event, args: CodeIntelIpcArgs) =>
    handleCodeIntelQuery('definition', args, event.sender.id)
  )
  ipcMain.handle('codeIntel:references', (event, args: CodeIntelIpcArgs) =>
    handleCodeIntelQuery('references', args, event.sender.id)
  )
  ipcMain.on('codeIntel:cancel', (event, requestId: number) =>
    cancelCodeIntelQuery(event.sender.id, requestId)
  )
}
