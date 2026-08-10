import { ipcMain } from 'electron'
import {
  admitEditorPopoutOpenRequest,
  type EditorPopoutOpenResult
} from '../../shared/editor-popout'
import {
  completeEditorPopoutSaveAndClose,
  getEditorPopoutRequest,
  isEditorPopoutRenderer,
  openEditorPopout,
  reportEditorPopoutCloseState,
  reportEditorPopoutReady,
  setEditorPopoutDirty
} from '../window/editor-popout-window'
import { getTrustedUIRendererWebContents } from './ui'

export function registerEditorPopoutHandlers(): void {
  ipcMain.removeHandler('editorPopout:open')
  ipcMain.removeHandler('editorPopout:getState')
  ipcMain.removeHandler('editorPopout:ready')
  ipcMain.removeHandler('editorPopout:setDirty')
  ipcMain.removeHandler('editorPopout:reportCloseState')
  ipcMain.removeHandler('editorPopout:completeSaveAndClose')

  ipcMain.handle(
    'editorPopout:open',
    async (event, value: unknown): Promise<EditorPopoutOpenResult> => {
      if (getTrustedUIRendererWebContents() !== event.sender) {
        return { created: false }
      }
      const request = admitEditorPopoutOpenRequest(value)
      if (!request) {
        return { created: false }
      }
      return openEditorPopout(request)
    }
  )

  ipcMain.handle('editorPopout:getState', (event) => {
    return isEditorPopoutRenderer(event.sender) ? getEditorPopoutRequest(event.sender) : null
  })

  ipcMain.handle('editorPopout:ready', (event): void => {
    if (isEditorPopoutRenderer(event.sender)) {
      reportEditorPopoutReady(event.sender)
    }
  })

  ipcMain.handle('editorPopout:setDirty', (event, dirty: unknown): void => {
    if (isEditorPopoutRenderer(event.sender) && typeof dirty === 'boolean') {
      setEditorPopoutDirty(event.sender, dirty)
    }
  })

  ipcMain.handle('editorPopout:reportCloseState', (event, dirty: unknown): void => {
    if (isEditorPopoutRenderer(event.sender) && typeof dirty === 'boolean') {
      reportEditorPopoutCloseState(event.sender, dirty)
    }
  })

  ipcMain.handle('editorPopout:completeSaveAndClose', (event, saved: unknown): void => {
    if (isEditorPopoutRenderer(event.sender) && typeof saved === 'boolean') {
      completeEditorPopoutSaveAndClose(event.sender, saved)
    }
  })
}
