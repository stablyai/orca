import { ipcMain } from 'electron'
import { admitEditorPopoutOpenRequest } from '../../shared/editor-popout'
import {
  completeEditorPopoutSaveAndClose,
  createOrFocusEditorPopout,
  getEditorPopoutRequest,
  isEditorPopoutRenderer,
  reportEditorPopoutCloseState,
  setEditorPopoutDirty
} from '../window/editor-popout-window'
import { getTrustedUIRendererWebContents } from './ui'

export function registerEditorPopoutHandlers(): void {
  ipcMain.removeHandler('editorPopout:open')
  ipcMain.removeHandler('editorPopout:getState')
  ipcMain.removeHandler('editorPopout:setDirty')
  ipcMain.removeHandler('editorPopout:reportCloseState')
  ipcMain.removeHandler('editorPopout:completeSaveAndClose')

  ipcMain.handle('editorPopout:open', (event, value: unknown): void => {
    if (getTrustedUIRendererWebContents() !== event.sender) {
      return
    }
    const request = admitEditorPopoutOpenRequest(value)
    if (request) {
      createOrFocusEditorPopout(request)
    }
  })

  ipcMain.handle('editorPopout:getState', (event) => {
    return isEditorPopoutRenderer(event.sender) ? getEditorPopoutRequest(event.sender) : null
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
