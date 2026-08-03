import type { RuntimeTerminalPathResolution } from '../../../src/shared/runtime-types'
import {
  createMobileFilePreviewHref,
  displayNameFromPreviewPath,
  type MobileFilePreviewHref
} from '../files/mobile-file-preview-route'
import type { MobileFileTapTarget } from '../files/mobile-file-tap-target'
import type { RpcClient } from '../transport/rpc-client'

const FILE_RESOLVE_TIMEOUT_MS = 10_000

function macHomePathRetry(pathText: string): string | null {
  const prefix = '/users/'
  if (!pathText.toLowerCase().startsWith(prefix) || pathText.startsWith('/Users/')) {
    return null
  }
  // iOS can lowercase /Users while typing an absolute path.
  return `/Users/${pathText.slice(prefix.length)}`
}

function resolvedWorktreePath(response: unknown): string | null {
  const resolved = response as RuntimeTerminalPathResolution
  if (!resolved.exists || resolved.isDirectory) {
    return null
  }
  if (resolved.openTarget?.kind === 'worktree-file') {
    return resolved.openTarget.relativePath
  }
  return resolved.openTarget ? null : (resolved.relativePath ?? null)
}

export async function resolveMobileNativeChatWorktreePath(args: {
  client: RpcClient
  worktreeId: string
  pathText: string
  terminal: string | null
}): Promise<string | null> {
  try {
    const worktree = `id:${args.worktreeId}`
    const resolvePath = async (pathText: string, terminal: string | null) => {
      const response = await args.client.sendRequest(
        'files.resolveTerminalPath',
        {
          worktree,
          pathText,
          ...(terminal ? { terminal } : {})
        },
        { timeoutMs: FILE_RESOLVE_TIMEOUT_MS }
      )
      return response.ok ? resolvedWorktreePath(response.result) : null
    }
    const rootPath = await resolvePath(args.pathText, null)
    if (rootPath) {
      return rootPath
    }
    if (args.terminal) {
      const terminalPath = await resolvePath(args.pathText, args.terminal)
      if (terminalPath) {
        return terminalPath
      }
    }
    const retryPath = macHomePathRetry(args.pathText)
    return retryPath ? await resolvePath(retryPath, null) : null
  } catch {
    return null
  }
}

export async function openMobileNativeChatFile(args: {
  client: RpcClient
  worktreeId: string
  hostId: string
  worktreeName?: string
  target: MobileFileTapTarget
  terminal: string | null
  pushPreviewRoute: (href: MobileFilePreviewHref) => void
  isCurrent?: () => boolean
}): Promise<boolean> {
  const relativePath = await resolveMobileNativeChatWorktreePath({
    ...args,
    pathText: args.target.pathText
  })
  if (!relativePath) {
    return false
  }
  if (args.isCurrent && !args.isCurrent()) {
    return false
  }
  try {
    args.pushPreviewRoute(
      createMobileFilePreviewHref({
        hostId: args.hostId,
        worktreeId: args.worktreeId,
        source: 'worktree',
        relativePath,
        name: displayNameFromPreviewPath(relativePath),
        ...(args.target.line !== null ? { line: String(args.target.line) } : {}),
        ...(args.target.column !== null ? { column: String(args.target.column) } : {}),
        ...(args.worktreeName ? { worktreeName: args.worktreeName } : {})
      })
    )
    return true
  } catch {
    return false
  }
}
