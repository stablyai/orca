import type { IpcRenderer } from 'electron'
const { ipcRenderer } = require('electron') as { ipcRenderer: IpcRenderer }
import type {
  ShellOpenExternalEditorRequest,
  ShellOpenExternalEditorResult,
  ShellOpenLocalPathResult
} from '../../shared/shell-open-types'
import type { PreloadApi } from '../api-types'
import type { ShellPathScope, ShellRuntimeScope } from './shell-api'

export function createShellBridge(prefix = 'shell'): PreloadApi['shell'] {
  return {
    openPath: (path: string, runtimeId?: ShellRuntimeScope): Promise<void> =>
      ipcRenderer.invoke(
        `${prefix}:openPath`,
        path,
        ...(runtimeId === undefined ? [] : [runtimeId])
      ),

    openInFileManager: (
      path: string,
      runtimeId?: ShellRuntimeScope
    ): Promise<ShellOpenLocalPathResult> =>
      ipcRenderer.invoke(
        `${prefix}:openInFileManager`,
        path,
        ...(runtimeId === undefined ? [] : [runtimeId])
      ),

    openInExternalEditor: (
      request: ShellOpenExternalEditorRequest,
      runtimeId?: ShellRuntimeScope
    ): Promise<ShellOpenExternalEditorResult> =>
      ipcRenderer.invoke(
        `${prefix}:openInExternalEditor`,
        request,
        ...(runtimeId === undefined ? [] : [runtimeId])
      ),

    openUrl: (url: string): Promise<void> => ipcRenderer.invoke(`${prefix}:openUrl`, url),

    openFilePath: (path: string, scope?: ShellPathScope): Promise<boolean> =>
      ipcRenderer.invoke(`${prefix}:openFilePath`, path, scope),

    openFileUri: (uri: string, scope?: ShellPathScope): Promise<void> =>
      ipcRenderer.invoke(`${prefix}:openFileUri`, uri, scope),

    pathExists: (path: string, scope?: ShellPathScope): Promise<boolean> =>
      ipcRenderer.invoke(`${prefix}:pathExists`, path, scope),

    pickAttachment: (): Promise<string | null> => ipcRenderer.invoke(`${prefix}:pickAttachment`),

    pickImage: (): Promise<string | null> => ipcRenderer.invoke(`${prefix}:pickImage`),

    pickRepoIconImage: (): Promise<{ dataUrl: string; fileName: string } | null> =>
      ipcRenderer.invoke(`${prefix}:pickRepoIconImage`),

    pickAudio: (): Promise<string | null> => ipcRenderer.invoke(`${prefix}:pickAudio`),

    pickDirectory: (args: { defaultPath?: string }): Promise<string | null> =>
      ipcRenderer.invoke(`${prefix}:pickDirectory`, args),

    copyFile: (
      args: { srcPath: string; destPath: string },
      scope?: ShellPathScope
    ): Promise<void> => ipcRenderer.invoke(`${prefix}:copyFile`, args, scope)
  }
}

export const shellApi = createShellBridge()
