import { execFile } from 'child_process'
import { readFile } from 'fs/promises'
import { promisify } from 'util'
import { join } from 'path'
import type { GitStatusEntry, GitFileStatus, GitDiffResult } from '../../shared/types'

const execFileAsync = promisify(execFile)

/**
 * Parse `git status --porcelain=v2` output into structured entries.
 */
export async function getStatus(worktreePath: string): Promise<GitStatusEntry[]> {
  const entries: GitStatusEntry[] = []

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v2', '--untracked-files=all'],
      { cwd: worktreePath, encoding: 'utf-8' }
    )

    for (const line of stdout.split('\n')) {
      if (!line) {
        continue
      }

      if (line.startsWith('1 ') || line.startsWith('2 ')) {
        // Changed entries: "1 XY sub mH mI mW hH path" or "2 XY sub mH mI mW hH X\tscore\tpath\torigPath"
        const parts = line.split(' ')
        const xy = parts[1]
        const indexStatus = xy[0]
        const worktreeStatus = xy[1]

        if (line.startsWith('2 ')) {
          // Rename entry - tab separated at the end
          const tabParts = line.split('\t')
          const path = tabParts[1]
          const oldPath = tabParts[2]
          if (indexStatus !== '.') {
            entries.push({ path, status: parseStatusChar(indexStatus), area: 'staged', oldPath })
          }
          if (worktreeStatus !== '.') {
            entries.push({
              path,
              status: parseStatusChar(worktreeStatus),
              area: 'unstaged',
              oldPath
            })
          }
        } else {
          // Regular change entry
          const path = parts.slice(8).join(' ')
          if (indexStatus !== '.') {
            entries.push({ path, status: parseStatusChar(indexStatus), area: 'staged' })
          }
          if (worktreeStatus !== '.') {
            entries.push({ path, status: parseStatusChar(worktreeStatus), area: 'unstaged' })
          }
        }
      } else if (line.startsWith('? ')) {
        // Untracked file
        const path = line.slice(2)
        entries.push({ path, status: 'untracked', area: 'untracked' })
      }
    }
  } catch {
    // Not a git repo or git not available
  }

  return entries
}

function parseStatusChar(char: string): GitFileStatus {
  switch (char) {
    case 'M':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    default:
      return 'modified'
  }
}

/**
 * Get original and modified content for diffing a file.
 */
export async function getDiff(
  worktreePath: string,
  filePath: string,
  staged: boolean
): Promise<GitDiffResult> {
  let originalContent = ''
  let modifiedContent = ''

  try {
    // Get original content (HEAD version)
    try {
      const { stdout } = await execFileAsync('git', ['show', `HEAD:${filePath}`], {
        cwd: worktreePath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024
      })
      originalContent = stdout
    } catch {
      // File is new (no HEAD version)
      originalContent = ''
    }

    if (staged) {
      // Staged: modified is the index version
      try {
        const { stdout } = await execFileAsync('git', ['show', `:${filePath}`], {
          cwd: worktreePath,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024
        })
        modifiedContent = stdout
      } catch {
        modifiedContent = ''
      }
    } else {
      // Unstaged: modified is the working tree version
      try {
        modifiedContent = await readFile(join(worktreePath, filePath), 'utf-8')
      } catch {
        modifiedContent = ''
      }
    }
  } catch {
    // Fallback
  }

  return { originalContent, modifiedContent }
}

/**
 * Stage a file.
 */
export async function stageFile(worktreePath: string, filePath: string): Promise<void> {
  await execFileAsync('git', ['add', '--', filePath], {
    cwd: worktreePath,
    encoding: 'utf-8'
  })
}

/**
 * Unstage a file.
 */
export async function unstageFile(worktreePath: string, filePath: string): Promise<void> {
  await execFileAsync('git', ['restore', '--staged', '--', filePath], {
    cwd: worktreePath,
    encoding: 'utf-8'
  })
}

/**
 * Discard working tree changes for a file.
 */
export async function discardChanges(worktreePath: string, filePath: string): Promise<void> {
  await execFileAsync('git', ['checkout', '--', filePath], {
    cwd: worktreePath,
    encoding: 'utf-8'
  })
}
