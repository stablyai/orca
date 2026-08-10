import { contextBridge, ipcRenderer } from 'electron'
import { createEditorPopoutPreloadApi } from './editor-popout-api'

contextBridge.exposeInMainWorld('api', createEditorPopoutPreloadApi(ipcRenderer))
