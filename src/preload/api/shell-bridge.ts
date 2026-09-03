import { ipcRenderer } from 'electron'
import type {
  ShellOpenExternalEditorRequest,
  ShellOpenExternalEditorResult,
  ShellOpenLocalPathResult
} from '../../shared/shell-open-types'
import type { PreloadApi } from '../api-types'

export const shellApi = {
  openPath: (path: string): Promise<void> => ipcRenderer.invoke('shell:openPath', path),

  openInFileManager: (path: string): Promise<ShellOpenLocalPathResult> =>
    ipcRenderer.invoke('shell:openInFileManager', path),

  openInExternalEditor: (
    request: ShellOpenExternalEditorRequest
  ): Promise<ShellOpenExternalEditorResult> =>
    ipcRenderer.invoke('shell:openInExternalEditor', request),

  openUrl: (url: string): Promise<void> => ipcRenderer.invoke('shell:openUrl', url),

  openFilePath: (path: string): Promise<boolean> => ipcRenderer.invoke('shell:openFilePath', path),

  openFileUri: (uri: string): Promise<void> => ipcRenderer.invoke('shell:openFileUri', uri),

  pathExists: (path: string): Promise<boolean> => ipcRenderer.invoke('shell:pathExists', path),

  pickAttachment: (): Promise<string | null> => ipcRenderer.invoke('shell:pickAttachment'),

  pickImage: (): Promise<string | null> => ipcRenderer.invoke('shell:pickImage'),

  pickRepoIconImage: (): Promise<{ dataUrl: string; fileName: string } | null> =>
    ipcRenderer.invoke('shell:pickRepoIconImage'),

  pickAudio: (): Promise<string | null> => ipcRenderer.invoke('shell:pickAudio'),

  pickDirectory: (args: { defaultPath?: string }): Promise<string | null> =>
    ipcRenderer.invoke('shell:pickDirectory', args),

  copyFile: (args: { srcPath: string; destPath: string }): Promise<void> =>
    ipcRenderer.invoke('shell:copyFile', args)
} satisfies PreloadApi['shell']
