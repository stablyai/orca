import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'

export function joinWorktreeRelativePath(rootPath: string, relativePath: string): string {
  const normalizedRelativePath = isWindowsAbsolutePathLike(rootPath)
    ? relativePath.replace(/\\/g, '/')
    : relativePath
  if (isWindowsAbsolutePathLike(rootPath)) {
    return win32.join(rootPath.replace(/\//g, '\\'), ...normalizedRelativePath.split('/'))
  }
  return posix.join(rootPath, ...normalizedRelativePath.split('/'))
}

export function normalizeRuntimeRelativePath(relativePath: string, rootPath?: string): string {
  const path =
    rootPath !== undefined && !isWindowsAbsolutePathLike(rootPath)
      ? relativePath
      : relativePath.replace(/\\/g, '/')
  const normalized = path.replace(/\/+$/, '')
  if (normalized === '') {
    return ''
  }
  if (!isSafeRuntimeRelativePath(normalized)) {
    throw new Error('invalid_relative_path')
  }
  return normalized
}

function isSafeRuntimeRelativePath(relativePath: string): boolean {
  if (relativePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(relativePath)) {
    return false
  }
  const parts = relativePath.split('/')
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}
