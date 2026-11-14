import type { RepoIconPickResult } from '../../../shared/repo-icon-pick-failure-copy'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { ShellPathExistence } from '../../../shared/file-access/path-existence-batch'
import type {
  ShellOpenExternalEditorRequest,
  ShellOpenExternalEditorResult,
  ShellOpenFileResult,
  ShellOpenLocalPathResult
} from '../../../shared/shell/opening/shell-open-types'

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
  openFileUri: (uri: string, ownerHostId: ExecutionHostId) => Promise<ShellOpenFileResult>
  pathsExist?: (paths: string[]) => Promise<ShellPathExistence[]>
  /** `wakeWslDistro`: a click, a user act that may start a stopped WSL distro. */
  pathExists: (path: string, options?: { wakeWslDistro?: boolean }) => Promise<boolean>
  pickAttachment: () => Promise<string | null>
  pickAttachments: () => Promise<string[]>
  pickImage: () => Promise<string | null>
  pickRepoIconImage: () => Promise<RepoIconPickResult>
  pickAudio: () => Promise<string | null>
  pickDirectory: (args: { defaultPath?: string }) => Promise<string | null>
}
