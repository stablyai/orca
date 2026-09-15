import type { ShellApi } from './shell-api'
import type { FilesystemApi } from './filesystem-api'
import type { WORKSPACE_WINDOW_FILE_TRANSFER_METHODS } from '../../shared/workspace-window-file-transfer'
import type { RuntimeApi } from './runtime-api'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { WorkspaceWindowMenuChannel } from '../../shared/workspace-window-native-bridge'
export type WorkspaceWindowNativeBridge = {
  presentationStorage?: {
    getItem: (key: string) => string | null
    setItem: (key: string, value: string) => void
    flush: () => Promise<void>
  }
  localRuntimeId: string
  runtimeEnvironments: RuntimeApi['runtimeEnvironments']
  browserInput: (request: {
    runtimeId: string | null
    environmentId?: string
    expectedEnvironmentPairingRevision?: number
    method: string
    params: unknown
  }) => Promise<RuntimeRpcResponse<unknown> | null>
  fileTransfer: Pick<FilesystemApi['fs'], (typeof WORKSPACE_WINDOW_FILE_TRANSFER_METHODS)[number]>
  subscribeBrowser: (
    request: {
      runtimeId: string | null
      environmentId?: string
      expectedEnvironmentPairingRevision?: number
      params: unknown
    },
    callbacks: Parameters<RuntimeApi['runtimeEnvironments']['subscribe']>[1]
  ) => Promise<Awaited<ReturnType<RuntimeApi['runtimeEnvironments']['subscribe']>> | null>
  shell: ShellApi
  onMenuEvent: (
    channel: WorkspaceWindowMenuChannel,
    callback: (data?: string) => void
  ) => () => void
  confirmClose: () => Promise<boolean>
  getWindowId: () => Promise<number>
  onCloseRequested: (callback: (data: { isQuitting: boolean }) => void) => () => void
  pickDirectory: () => Promise<string | null>
  pickFolder: () => Promise<string | null>
  pickFolders: () => Promise<string[]>
  requestClose: () => Promise<void>
}
