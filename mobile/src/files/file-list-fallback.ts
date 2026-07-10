// Fallback for desktops that predate files.readDir in the mobile RPC
// allowlist: synthesize the lazy directory cache from the flat, capped
// files.list result so the Files tab stays browsable against old desktops.
import type { DirectoryCache, MobileDirEntry } from './file-tree'

export type LegacyMobileFileEntry = {
  relativePath: string
  basename: string
  kind: 'text' | 'binary'
}

export type LegacyFilesListResult = {
  files: LegacyMobileFileEntry[]
  totalCount: number
  truncated: boolean
}

// Same detection shape as isMobileGitUnavailable in mobile-git-status.ts:
// 'forbidden' = method exists but is not mobile-allowlisted on the old
// desktop; 'method_not_found' = desktop predates the method entirely.
export function isMobileMethodUnavailableError(
  code: string | undefined,
  message: string | undefined
): boolean {
  return (
    code === 'forbidden' ||
    code === 'method_not_found' ||
    message?.includes('not available to mobile clients') === true
  )
}

export function directoryCacheFromFileList(files: LegacyMobileFileEntry[]): DirectoryCache {
  const childrenByDir = new Map<string, Map<string, boolean>>()
  const ensureDir = (path: string): Map<string, boolean> => {
    let children = childrenByDir.get(path)
    if (!children) {
      children = new Map()
      childrenByDir.set(path, children)
    }
    return children
  }
  ensureDir('')
  for (const file of files) {
    const parts = file.relativePath.split('/').filter(Boolean)
    let parentPath = ''
    parts.forEach((name, index) => {
      const isDirectory = index < parts.length - 1
      const children = ensureDir(parentPath)
      children.set(name, children.get(name) === true || isDirectory)
      parentPath = parentPath ? `${parentPath}/${name}` : name
      if (isDirectory) {
        ensureDir(parentPath)
      }
    })
  }
  // Why: plain `cache[path] = ...` with a '__proto__' path segment mutates the
  // object's prototype instead of storing the directory; fromEntries always
  // creates own keys.
  return Object.fromEntries(
    Array.from(childrenByDir, ([path, children]) => [
      path,
      {
        entries: Array.from(
          children,
          ([name, isDirectory]): MobileDirEntry => ({
            name,
            isDirectory
          })
        )
      }
    ])
  )
}
