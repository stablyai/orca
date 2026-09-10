import type {
  RuntimeFileOpenResult,
  RuntimeTerminalPathResolution
} from '../../../src/shared/runtime-types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import type {
  HostSessionTerminalFileOperations,
  HostSessionTerminalFileTarget
} from './host-session-terminal-file-operations'

export function nativeHostSessionTerminalFileOperations(
  client: RpcClient
): HostSessionTerminalFileOperations {
  return {
    async resolveTerminalPath(request) {
      const response = await client.sendRequest(
        'files.resolveTerminalPath',
        {
          worktree: `id:${request.workspaceId}`,
          pathText: request.pathText,
          crossWorkspace: true,
          ...(request.terminalHandle ? { terminal: request.terminalHandle } : {}),
          ...(request.cwd ? { cwd: request.cwd } : {}),
          ...(request.nativeChatContext ? { nativeChatContext: request.nativeChatContext } : {})
        },
        { timeoutMs: 10_000 }
      )
      if (!response.ok) {
        return null
      }
      return nativeTerminalFileTarget(
        (response as RpcSuccess).result as RuntimeTerminalPathResolution
      )
    },
    async openWorktreeFile(workspaceId, relativePath) {
      const response = await client.sendRequest(
        'files.open',
        { worktree: `id:${workspaceId}`, relativePath },
        { timeoutMs: 15_000 }
      )
      if (!response.ok || !(response.result as RuntimeFileOpenResult).opened) {
        throw new Error('file_open_failed')
      }
    }
  }
}

function nativeTerminalFileTarget(
  resolved: RuntimeTerminalPathResolution
): HostSessionTerminalFileTarget | null {
  if (!resolved.exists || resolved.isDirectory) {
    return null
  }
  if (resolved.openTarget?.kind === 'absolute-file') {
    return {
      kind: 'native-artifact',
      absolutePath: resolved.openTarget.absolutePath,
      grantId: resolved.openTarget.grantId,
      ...(resolved.worktree ? { workspaceId: resolved.worktree } : {})
    }
  }
  const relativePath =
    resolved.openTarget?.kind === 'worktree-file'
      ? resolved.openTarget.relativePath
      : resolved.relativePath
  if (!relativePath) {
    return null
  }
  return {
    kind: 'worktree-file',
    relativePath,
    ...(resolved.worktree ? { workspaceId: resolved.worktree } : {}),
    localAbsolutePath:
      resolved.openTarget?.kind === 'worktree-file' && resolved.openTarget.provider === 'local'
        ? resolved.openTarget.absolutePath
        : null
  }
}
