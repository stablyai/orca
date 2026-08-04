import type { RuntimeTerminalPathResolution } from '../../../src/shared/runtime-types'
import type { RpcClient } from '../transport/rpc-client'

type MobileNativeChatWorktreeTarget = {
  worktreeId: string
  relativePath: string
}

async function resolveMobileNativeChatWorktreeTarget(args: {
  client: RpcClient
  worktreeId: string
  pathText: string
  terminal: string | null
}): Promise<MobileNativeChatWorktreeTarget | null> {
  try {
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
    const relativePath =
      resolved.openTarget?.kind === 'worktree-file'
        ? resolved.openTarget.relativePath
        : (resolved.relativePath ?? null)
    return relativePath
      ? { worktreeId: resolved.worktree?.trim() || args.worktreeId, relativePath }
      : null
  } catch {
    return null
  }
}

export async function resolveMobileNativeChatWorktreePath(args: {
  client: RpcClient
  worktreeId: string
  pathText: string
  terminal: string | null
}): Promise<string | null> {
  return (await resolveMobileNativeChatWorktreeTarget(args))?.relativePath ?? null
}

export async function openMobileNativeChatFile(args: {
  client: RpcClient
  worktreeId: string
  pathText: string
  terminal: string | null
}): Promise<void> {
  const target = await resolveMobileNativeChatWorktreeTarget(args)
  if (target) {
    try {
      await args.client.sendRequest('files.open', {
        worktree: `id:${target.worktreeId}`,
        relativePath: target.relativePath
      })
    } catch {
      // Best-effort open; failures surface as a no-op rather than an
      // unhandled rejection.
    }
  }
}
