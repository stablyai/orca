// Synthesize the lazy cache from capped files.list for hosts predating the mobile readDir allowlist.
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

// Require only relativePath; the explorer reader deliberately passes other row members through unchecked.
export function directoryCacheFromFileList(
  files: readonly { relativePath: string; [member: string]: unknown }[]
): DirectoryCache {
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
  // fromEntries stores __proto__ as an own key; assignment would mutate the cache prototype.
  return Object.fromEntries(
    Array.from(childrenByDir, ([path, children]) => [
      path,
      {
        entries: Array.from(children, ([name, isDirectory]): MobileDirEntry => ({
          name,
          isDirectory
        }))
      }
    ])
  )
}
