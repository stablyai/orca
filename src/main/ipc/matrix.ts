import { ipcMain } from 'electron'
import { getMatrixService } from '../matrix/matrix-service'
import type { MatrixConnectionStatus, OutboundResult } from '../matrix/types'

// Why: IPC args arrive untyped at runtime — mirror linear.ts and reject empty
// strings up front so the service never starts work on a non-credential.
function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`)
  }
  return value.trim()
}

export function registerMatrixHandlers(): void {
  ipcMain.handle('matrix:status', async (): Promise<MatrixConnectionStatus> => {
    return getMatrixService().getStatus()
  })

  ipcMain.handle(
    'matrix:connect',
    async (_event, args: { token: string }): Promise<{ ok: boolean; error?: string }> => {
      // Why: don't trim the token here — pass the raw validated value so the
      // service stores exactly what the user pasted (tokens are opaque).
      if (typeof args?.token !== 'string' || !args.token.trim()) {
        return { ok: false, error: 'Access token is required' }
      }
      return getMatrixService().connect(args.token)
    }
  )

  ipcMain.handle('matrix:disconnect', async (): Promise<void> => {
    await getMatrixService().disconnect()
  })

  ipcMain.handle(
    'matrix:sendTest',
    async (_event, args: { message: string }): Promise<OutboundResult> => {
      let message: string
      try {
        message = requireNonEmptyString(args?.message, 'Message')
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Message is required' }
      }
      return getMatrixService().sendToRoom(message)
    }
  )
}
