import type { RuntimeNativeChatFileContext } from '../../../src/shared/runtime-types'

export type HostSessionTerminalFileTarget =
  | {
      kind: 'worktree-file'
      relativePath: string
      localAbsolutePath: string | null
      workspaceId?: string
    }
  | {
      kind: 'native-artifact'
      absolutePath: string
      grantId: string
      workspaceId?: string
    }
  | {
      kind: 'web-artifact'
      token: string
      displayName: string
      previewKind: 'text' | 'raster'
      workspaceId?: string
    }

export type HostSessionTerminalFileResolveRequest = {
  workspaceId: string
  tabId: string
  terminalHandle: string | null
  pathText: string
  cwd: string | null
  nativeChatContext: RuntimeNativeChatFileContext | null
  line: number | null
  column: number | null
}

export type HostSessionTerminalFileOperations = {
  resolveTerminalPath(
    request: HostSessionTerminalFileResolveRequest
  ): Promise<HostSessionTerminalFileTarget | null>
  openWorktreeFile(workspaceId: string, relativePath: string): Promise<void>
}
