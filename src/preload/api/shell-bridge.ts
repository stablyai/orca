import type { RepoIconPickResult } from '../../shared/repo-icon-pick-failure-copy'
import { ipcRenderer } from 'electron'
import type {
  ShellOpenExternalEditorRequest,
  ShellOpenExternalEditorResult,
  ShellOpenLocalPathResult
} from '../../shared/shell-open-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { ShellPathExistence } from '../../shared/path-existence-batch'
import type { PreloadApi } from '../api-types'

export const shellApi = {
  openPath: (path: string, ownerHostId: ExecutionHostId): Promise<void> =>
    ipcRenderer.invoke('shell:openPath', path, ownerHostId),

  openInFileManager: (
    path: string,
    ownerHostId: ExecutionHostId
  ): Promise<ShellOpenLocalPathResult> =>
    ipcRenderer.invoke('shell:openInFileManager', path, ownerHostId),

  openInExternalEditor: (
    request: ShellOpenExternalEditorRequest
  ): Promise<ShellOpenExternalEditorResult> =>
    ipcRenderer.invoke('shell:openInExternalEditor', request),

  openUrl: (url: string): Promise<void> => ipcRenderer.invoke('shell:openUrl', url),

  openFilePath: (path: string, ownerHostId: ExecutionHostId): Promise<boolean> =>
    ipcRenderer.invoke('shell:openFilePath', path, ownerHostId),

  openFileUri: (uri: string, ownerHostId: ExecutionHostId): Promise<void> =>
    ipcRenderer.invoke('shell:openFileUri', uri, ownerHostId),

  pathsExist: (paths: string[]): Promise<ShellPathExistence[]> =>
    ipcRenderer.invoke('shell:pathsExist', paths),
  pathExists: (path: string, options?: { wakeWslDistro?: boolean }): Promise<boolean> =>
    ipcRenderer.invoke('shell:pathExists', path, options),

  pickAttachment: (): Promise<string | null> => ipcRenderer.invoke('shell:pickAttachment'),

  pickAttachments: (): Promise<string[]> => ipcRenderer.invoke('shell:pickAttachments'),

  pickImage: (): Promise<string | null> => ipcRenderer.invoke('shell:pickImage'),

  pickRepoIconImage: (): Promise<RepoIconPickResult> =>
    ipcRenderer.invoke('shell:pickRepoIconImage'),

  pickAudio: (): Promise<string | null> => ipcRenderer.invoke('shell:pickAudio'),

  pickDirectory: (args: { defaultPath?: string }): Promise<string | null> =>
    ipcRenderer.invoke('shell:pickDirectory', args),

  copyFile: (args: { srcPath: string; destPath: string }): Promise<void> =>
    ipcRenderer.invoke('shell:copyFile', args)
} satisfies PreloadApi['shell']
