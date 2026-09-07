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

export type ShellPathScope =
  | { kind: 'local-artifact' }
  | { kind: 'workspace'; runtimeId: string | null; connectionId?: string | null }

export type ShellRuntimeScope = string | null | ShellPathScope

export type ShellApi = {
  openPath: (path: string, scope?: ShellRuntimeScope) => Promise<void>
  openInFileManager: (path: string, scope?: ShellRuntimeScope) => Promise<ShellOpenLocalPathResult>
  openInExternalEditor: (
    request: ShellOpenExternalEditorRequest,
    scope?: ShellRuntimeScope
  ) => Promise<ShellOpenExternalEditorResult>
  openUrl: (url: string) => Promise<void>
  openFilePath: (path: string, scope?: ShellPathScope) => Promise<boolean>
  openFileUri: (uri: string, scope?: ShellPathScope) => Promise<void>
  pathExists: (path: string, scope?: ShellPathScope) => Promise<boolean>
  pickAttachment: () => Promise<string | null>
  pickImage: () => Promise<string | null>
  pickRepoIconImage: () => Promise<{
    dataUrl: string
    fileName: string
  } | null>
  pickAudio: () => Promise<string | null>
  pickDirectory: (args: { defaultPath?: string }) => Promise<string | null>
  copyFile: (args: { srcPath: string; destPath: string }, scope?: ShellPathScope) => Promise<void>
}
