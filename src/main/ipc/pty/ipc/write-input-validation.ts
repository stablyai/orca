import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { PtyRendererDelivery } from '../session'
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'

export type PtyWritePayload = {
  id: string
  data: string
  inputKind: TerminalInputKind
  requireWriteSettlement?: true
}
export type PtyViewportClaimPayload = { id: string; cols: number; rows: number }

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

export function isPtyWritePayload(value: unknown): value is PtyWritePayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    'data' in value &&
    typeof value.data === 'string'
  )
}

export function isPtyViewportClaimPayload(value: unknown): value is PtyViewportClaimPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    'cols' in value &&
    typeof value.cols === 'number' &&
    Number.isFinite(value.cols) &&
    value.cols > 0 &&
    'rows' in value &&
    typeof value.rows === 'number' &&
    Number.isFinite(value.rows) &&
    value.rows > 0
  )
}
