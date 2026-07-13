import type { RuntimeTerminalPathResolution } from '../../../src/shared/runtime-types'
import type { RpcClient } from '../transport/rpc-client'

export async function resolveMobileNativeChatWorktreePath(args: {
  client: RpcClient
  worktreeId: string
  pathText: string
  terminal: string | null
}): Promise<string | null> {
  const response = await args.client.sendRequest('files.resolveTerminalPath', {
    worktree: `id:${args.worktreeId}`,
    pathText: args.pathText,
    ...(args.terminal ? { terminal: args.terminal } : {})
  })
  if (!response.ok) {
    return null
  }
  const resolved = response.result as RuntimeTerminalPathResolution
  if (!resolved.exists || resolved.isDirectory) {
    return null
  }
  return resolved.openTarget?.kind === 'worktree-file'
    ? resolved.openTarget.relativePath
    : (resolved.relativePath ?? null)
}

export async function openMobileNativeChatFile(args: {
  client: RpcClient
  worktreeId: string
  pathText: string
  terminal: string | null
}): Promise<void> {
  const relativePath = await resolveMobileNativeChatWorktreePath(args)
  if (relativePath) {
    await args.client.sendRequest('files.open', {
      worktree: `id:${args.worktreeId}`,
      relativePath
    })
  }
}
