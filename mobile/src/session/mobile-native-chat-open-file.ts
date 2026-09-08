import { splitFilePathLineSuffix } from '../components/markdown-file-path-detection'
import type { RuntimeTerminalPathResolution } from '../../../src/shared/runtime-types'
import type { RpcClient } from '../transport/rpc-client'
import {
  openMobileFileTap,
  type FileTapSessionTab,
  type OpenMobileFileTapOptions
} from './mobile-file-tap-open'

export type OpenMobileNativeChatFileTapOptions<T extends FileTapSessionTab> = Omit<
  OpenMobileFileTapOptions<T>,
  'terminalHandle' | 'cwd' | 'line' | 'column'
>

/**
 * Open a file reference tapped in native chat: same haptic / preview-route /
 * tab-activation flow as terminal taps, but chat paths are worktree-root
 * relative (or absolute), so resolution deliberately passes no terminal handle
 * and no cwd — a terminal's live cwd (e.g. `<worktree>/mobile`) would misplace
 * them. Agent-style `path:line(:col)` citations carry their location through.
 */
export function openMobileNativeChatFileTap<T extends FileTapSessionTab>(
  options: OpenMobileNativeChatFileTapOptions<T>
): void {
  const { path, line, column } = splitFilePathLineSuffix(options.pathText)
  openMobileFileTap<T>({
    ...options,
    pathText: path,
    line,
    column
  })
}

export async function resolveMobileNativeChatWorktreePath(args: {
  client: RpcClient
  worktreeId: string
  pathText: string
  terminal: string | null
}): Promise<string | null> {
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
    return resolved.openTarget?.kind === 'worktree-file'
      ? resolved.openTarget.relativePath
      : (resolved.relativePath ?? null)
  } catch {
    return null
  }
}

export async function openMobileNativeChatFile(args: {
  client: RpcClient
  worktreeId: string
  pathText: string
  terminal: string | null
}): Promise<void> {
  const relativePath = await resolveMobileNativeChatWorktreePath(args)
  if (!relativePath) {
    return
  }
  try {
    await args.client.sendRequest('files.open', {
      worktree: `id:${args.worktreeId}`,
      relativePath
    })
  } catch {
    // Best-effort open from transcript content.
  }
}
