import {
  isRuntimePathAbsolute,
  isWindowsAbsolutePathLike,
  resolveRuntimePath
} from '../../../shared/cross-platform-path'
import { parseWslPath, toWindowsWslPath } from '../../wsl'

export function resolveTerminalAbsolutePath(args: {
  base: string
  expanded: string
  worktreePath: string
  connectionId?: string
  terminalFileUriHostname?: string | null
}): string {
  const expanded = normalizeTerminalFileUriAuthorityPath(
    args.expanded,
    args.connectionId,
    args.terminalFileUriHostname,
    args.worktreePath
  )
  const absolutePath = isRuntimePathAbsolute(expanded)
    ? expanded
    : resolveRuntimePath(args.base, expanded)
  if (args.connectionId) {
    return normalizeLeadingSlashDrivePath(absolutePath, args.worktreePath)
  }
  const wsl = parseWslPath(args.worktreePath)
  if (wsl && absolutePath.startsWith('/') && !absolutePath.startsWith('//')) {
    return toWindowsWslPath(absolutePath, wsl.distro)
  }
  return absolutePath
}

export function normalizeTerminalFileUriAuthorityPath(
  pathText: string,
  connectionId?: string,
  terminalFileUriHostname?: string | null,
  worktreePath?: string
): string {
  if (!pathText.startsWith('//')) {
    return pathText
  }
  const match = /^\/\/([^/\\]+)([/\\].*)$/.exec(pathText)
  if (!match) {
    return pathText
  }
  const host = match[1]!.toLowerCase()
  if (terminalFileUriHostname && host === terminalFileUriHostname.toLowerCase() && connectionId) {
    return normalizeLeadingSlashDrivePath(match[2]!, worktreePath)
  }
  if (isLoopbackFileUriHostname(host) && (connectionId || process.platform !== 'win32')) {
    return normalizeLeadingSlashDrivePath(match[2]!, worktreePath)
  }
  // Why: without a verified host match, stripping the file-URI authority could open a same-path artifact on the wrong machine.
  return pathText
}

export function isLoopbackFileUriHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

export function normalizeLeadingSlashDrivePath(pathText: string, worktreePath?: string): string {
  return worktreePath &&
    isWindowsAbsolutePathLike(worktreePath) &&
    /^\/[A-Za-z]:[\\/]/.test(pathText)
    ? pathText.slice(1)
    : pathText
}
