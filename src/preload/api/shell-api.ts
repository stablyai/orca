import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  ShellOpenExternalEditorRequest,
  ShellOpenExternalEditorResult,
  ShellOpenLocalPathResult
} from '../../shared/shell-open-types'

export type {
  ShellOpenExternalEditorRequest,
  ShellOpenExternalEditorResult,
  ShellOpenLocalPathResult
} from '../../shared/shell-open-types'

export type ShellApi = {
  /** Every OS open names the path's owner; main refuses anything not owned by this computer. */
  openPath: (path: string, ownerHostId: ExecutionHostId) => Promise<void>
  openInFileManager: (
    path: string,
    ownerHostId: ExecutionHostId
  ) => Promise<ShellOpenLocalPathResult>
  openInExternalEditor: (
    request: ShellOpenExternalEditorRequest
  ) => Promise<ShellOpenExternalEditorResult>
  openUrl: (url: string) => Promise<void>
  openFilePath: (path: string, ownerHostId: ExecutionHostId) => Promise<boolean>
  openFileUri: (uri: string, ownerHostId: ExecutionHostId) => Promise<void>
  pathsExist?: (paths: string[]) => Promise<boolean[]>
  pathExists: (path: string) => Promise<boolean>
  pickAttachment: () => Promise<string | null>
  pickAttachments: () => Promise<string[]>
  pickImage: () => Promise<string | null>
  pickRepoIconImage: () => Promise<{
    dataUrl: string
    fileName: string
  } | null>
  pickAudio: () => Promise<string | null>
  pickDirectory: (args: { defaultPath?: string }) => Promise<string | null>
  copyFile: (args: { srcPath: string; destPath: string }) => Promise<void>
}
