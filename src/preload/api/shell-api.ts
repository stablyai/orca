import type {
  ShellListOpenWithApplicationsResult,
  ShellOpenExternalEditorRequest,
  ShellOpenExternalEditorResult,
  ShellOpenLocalPathResult,
  ShellOpenPathWithApplicationRequest
} from '../../shared/shell-open-types'

export type {
  ShellListOpenWithApplicationsResult,
  ShellOpenExternalEditorRequest,
  ShellOpenExternalEditorResult,
  ShellOpenLocalPathResult,
  ShellOpenPathWithApplicationRequest
} from '../../shared/shell-open-types'

export type ShellApi = {
  openPath: (path: string) => Promise<void>
  openInFileManager: (path: string) => Promise<ShellOpenLocalPathResult>
  openInExternalEditor: (
    request: ShellOpenExternalEditorRequest
  ) => Promise<ShellOpenExternalEditorResult>
  openUrl: (url: string) => Promise<void>
  openFilePath: (path: string) => Promise<boolean>
  listOpenWithApplications: (path: string) => Promise<ShellListOpenWithApplicationsResult>
  openPathWithApplication: (
    request: ShellOpenPathWithApplicationRequest
  ) => Promise<ShellOpenLocalPathResult>
  openFileUri: (uri: string) => Promise<void>
  pathExists: (path: string) => Promise<boolean>
  pickAttachment: () => Promise<string | null>
  pickImage: () => Promise<string | null>
  pickRepoIconImage: () => Promise<{
    dataUrl: string
    fileName: string
  } | null>
  pickAudio: () => Promise<string | null>
  pickDirectory: (args: { defaultPath?: string }) => Promise<string | null>
  copyFile: (args: { srcPath: string; destPath: string }) => Promise<void>
}
