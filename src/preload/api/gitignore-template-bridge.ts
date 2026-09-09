import { ipcRenderer } from 'electron'
import type { GitignoreTemplateApi } from './gitignore-template-api'

export const gitignoreTemplatesApi: GitignoreTemplateApi['gitignoreTemplates'] = {
  list: () => ipcRenderer.invoke('gitignore-templates:list'),
  get: (name) => ipcRenderer.invoke('gitignore-templates:get', name)
}
