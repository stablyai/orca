import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type {
  HostSessionTerminalFileOperations,
  HostSessionTerminalFileTarget
} from './host-session-terminal-file-operations'

export function webHostSessionTerminalFileOperations(
  client: MobileWebBridgeClient
): HostSessionTerminalFileOperations {
  return {
    async resolveTerminalPath(request) {
      const result = await client.fileResolveTerminalPath({
        workspaceId: request.workspaceId,
        tabId: request.tabId,
        pathText: request.pathText,
        line: request.line,
        column: request.column
      })
      return webTerminalFileTarget(result)
    },
    async openWorktreeFile(workspaceId, relativePath) {
      await client.fileOpen({ workspaceId, relativePath })
    }
  }
}

function webTerminalFileTarget(
  result: Awaited<ReturnType<MobileWebBridgeClient['fileResolveTerminalPath']>>
): HostSessionTerminalFileTarget {
  return result.kind === 'worktree-file'
    ? {
        kind: 'worktree-file',
        relativePath: result.relativePath,
        localAbsolutePath: null,
        workspaceId: result.workspaceId
      }
    : {
        kind: 'web-artifact',
        token: result.token,
        displayName: result.displayName,
        previewKind: result.previewKind,
        workspaceId: result.workspaceId
      }
}
