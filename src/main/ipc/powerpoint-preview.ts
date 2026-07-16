import { ipcMain } from 'electron'
import type {
  NativePowerPointPreviewCancelRequest,
  NativePowerPointPreviewRequest
} from '../../shared/powerpoint-preview'
import { renderNativePowerPointPreview } from '../office/native-powerpoint-preview'
import { createSenderScopedRequestCancellations } from './sender-scoped-request-cancellation'

export function registerPowerPointPreviewHandlers(): void {
  const cancellations = createSenderScopedRequestCancellations()
  ipcMain.removeHandler('powerpointPreview:render')
  ipcMain.removeHandler('powerpointPreview:cancel')
  ipcMain.handle(
    'powerpointPreview:render',
    async (event, request: NativePowerPointPreviewRequest) => {
      const controller = cancellations.begin(event, request.requestToken)
      try {
        return await renderNativePowerPointPreview(request, undefined, controller?.signal)
      } finally {
        cancellations.finish(event, request.requestToken, controller)
      }
    }
  )
  ipcMain.handle(
    'powerpointPreview:cancel',
    (event, request: NativePowerPointPreviewCancelRequest): void =>
      cancellations.cancel(event, request.requestToken)
  )
}
