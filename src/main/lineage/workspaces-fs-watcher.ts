import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getActiveLineageContext } from './pty-env-injector'
import { notifyWorktreeCreated, type LineageStoreContract } from './workspace-lineage-service'

export type WorkspacesFsWatcherOptions = {
  watchRoot?: string
  debounceMs?: number
  store?: LineageStoreContract
  onDiscovered?: (info: {
    worktreePath: string
    repoName: string
    branch: string
    childKey: string
  }) => void
}

let activeWatcher: fs.FSWatcher | null = null
let debounceTimer: NodeJS.Timeout | null = null

export function getDefaultWorkspacesRoot(): string {
  return path.join(os.homedir(), 'orca', 'workspaces')
}

export function parseGitPointer(gitFilePath: string): { gitdir: string } | null {
  try {
    if (!fs.existsSync(gitFilePath)) {
      return null
    }
    const stat = fs.statSync(gitFilePath)
    if (stat.isFile()) {
      const content = fs.readFileSync(gitFilePath, 'utf-8').trim()
      const match = content.match(/^gitdir:\s*(.+)$/m)
      if (match) {
        return { gitdir: match[1].trim() }
      }
    } else if (stat.isDirectory()) {
      return { gitdir: gitFilePath }
    }
  } catch {
    return null
  }
  return null
}

export function handleDiscoveredWorktree(
  worktreePath: string,
  store?: LineageStoreContract,
  options?: Pick<WorkspacesFsWatcherOptions, 'watchRoot' | 'onDiscovered'>
): boolean {
  const activeContext = getActiveLineageContext()
  if (!activeContext?.parentWorkspaceKey) {
    return false
  }

  const watchRoot = options?.watchRoot
    ? path.resolve(options.watchRoot)
    : getDefaultWorkspacesRoot()
  const resolvedWorktreePath = path.resolve(worktreePath)
  const relativePath = path.relative(watchRoot, resolvedWorktreePath)

  const parts = relativePath.split(path.sep).filter(Boolean)
  let repoName = 'unknown'
  let branch = path.basename(resolvedWorktreePath)

  if (parts.length >= 2) {
    repoName = parts[0]
    branch = parts.slice(1).join('/')
  } else if (parts.length === 1) {
    repoName = parts[0]
  }

  // Also check if .git file gives more repo/branch information
  const gitFilePath = path.join(resolvedWorktreePath, '.git')
  const gitPointer = parseGitPointer(gitFilePath)
  if (gitPointer) {
    // e.g. gitdir: /path/to/main-repo/.git/worktrees/branch-name
    const gitDirParts = gitPointer.gitdir.replace(/\\/g, '/').split('/')
    const wtIndex = gitDirParts.lastIndexOf('worktrees')
    if (wtIndex !== -1 && gitDirParts[wtIndex + 1]) {
      branch = gitDirParts.slice(wtIndex + 1).join('/')
    }
  }

  const childKey = `worktree:${repoName}:${branch}`

  if (store) {
    notifyWorktreeCreated(store, {
      worktreePath: resolvedWorktreePath,
      repoName,
      branch,
      parentWorkspaceKey: activeContext.parentWorkspaceKey
    })
  }

  options?.onDiscovered?.({
    worktreePath: resolvedWorktreePath,
    repoName,
    branch,
    childKey
  })

  return true
}

export function findGitPointers(dir: string, maxDepth = 4): string[] {
  const results: string[] = []
  if (maxDepth <= 0 || !fs.existsSync(dir)) {
    return results
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '.git') {
        results.push(dir)
      } else if (entry.isDirectory() && entry.name !== 'node_modules') {
        results.push(...findGitPointers(path.join(dir, entry.name), maxDepth - 1))
      }
    }
  } catch {}
  return results
}

export function startWorkspacesFsWatcher(
  options: WorkspacesFsWatcherOptions = {}
): fs.FSWatcher | null {
  stopWorkspacesFsWatcher()

  const watchRoot = options.watchRoot ? path.resolve(options.watchRoot) : getDefaultWorkspacesRoot()
  const debounceMs = options.debounceMs ?? 300

  if (!fs.existsSync(watchRoot)) {
    try {
      fs.mkdirSync(watchRoot, { recursive: true })
    } catch {
      return null
    }
  }

  try {
    const watcher = fs.watch(watchRoot, { recursive: true }, (_eventType, _filename) => {
      if (debounceTimer) {
        clearTimeout(debounceTimer)
      }
      debounceTimer = setTimeout(() => {
        const found = findGitPointers(watchRoot)
        for (const wtDir of found) {
          handleDiscoveredWorktree(wtDir, options.store, {
            watchRoot,
            onDiscovered: options.onDiscovered
          })
        }
      }, debounceMs)
    })

    activeWatcher = watcher
    return watcher
  } catch (error) {
    console.warn('[workspaces-fs-watcher] Could not start watcher on', watchRoot, error)
    return null
  }
}

export function stopWorkspacesFsWatcher(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (activeWatcher) {
    try {
      activeWatcher.close()
    } catch {}
    activeWatcher = null
  }
}
