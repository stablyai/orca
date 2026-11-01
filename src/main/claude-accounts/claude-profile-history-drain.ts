import type { HistoryDirectory } from '../../shared/history-filesystem'
import { runFileOperationWithWindowsRetry } from '../../shared/windows-retry-file-operations'
import { crossFilesystem } from './claude-profile-prompt-history'
import {
  ClaudeProfileSurfaceError,
  warnClaudeProfile,
  type ClaudeProfileReport
} from './claude-profile-report'

type MoveResult = { retained: number; failed: unknown[] }

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

export function retry<T>(operation: () => T): T {
  try {
    return runFileOperationWithWindowsRetry(operation)
  } catch (error) {
    if (hasCode(error, 'EXDEV')) {
      throw crossFilesystem()
    }
    throw error
  }
}

function openOrCreate(
  parent: HistoryDirectory,
  name: string,
  like: HistoryDirectory
): HistoryDirectory {
  try {
    retry(() => parent.mkdir(name, like))
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) {
      throw error
    }
  }
  return retry(() => parent.open(name))
}

// Internal directories never change role by being promoted into the shared tree.
function moveHistoryTree(
  source: HistoryDirectory,
  destination: HistoryDirectory,
  result: MoveResult
): void {
  if (source.same(destination)) {
    return
  }
  for (const name of source.entries()) {
    try {
      if (source.kind(name) === 'directory') {
        const child = openIfPresent(source, name)
        if (!child) {
          // Another setup already drained and removed it.
          continue
        }
        let target: HistoryDirectory | undefined
        try {
          try {
            target = openOrCreate(destination, name, child)
          } catch (error) {
            if (destination.kind(name) !== 'directory' && destination.kind(name) !== null) {
              result.retained += 1
              continue
            }
            throw error
          }
          moveHistoryTree(child, target, result)
        } finally {
          target?.close()
          child.close()
        }
        removeEmpty(source, name)
      } else if (retry(() => source.move(name, destination, name)) === 'collision') {
        result.retained += 1
      }
    } catch (error) {
      result.failed.push(error)
    }
  }
}

function openIfPresent(parent: HistoryDirectory, name: string): HistoryDirectory | undefined {
  try {
    return retry(() => parent.open(name))
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return undefined
    }
    throw error
  }
}

function removeEmpty(parent: HistoryDirectory, name: string): boolean {
  try {
    retry(() => parent.removeEmpty(name))
    return true
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return true
    }
    if (hasCode(error, 'ENOTEMPTY') || hasCode(error, 'EEXIST')) {
      return false
    }
    throw error
  }
}

export function drainDirectory(
  parent: HistoryDirectory,
  pending: string,
  destination: HistoryDirectory,
  report: ClaudeProfileReport,
  name: string,
  pendingPath: string
): void {
  const source = openIfPresent(parent, pending)
  if (!source) {
    return
  }
  if (source.same(destination)) {
    source.close()
    return
  }
  const result: MoveResult = { retained: 0, failed: [] }
  try {
    moveHistoryTree(source, destination, result)
  } finally {
    source.close()
  }
  try {
    // An entry that failed to move is what keeps P non-empty, not a conflict.
    if (!removeEmpty(parent, pending) && !result.failed.length) {
      result.retained = Math.max(1, result.retained)
    }
  } catch (error) {
    result.failed.push(error)
  }
  if (result.failed.length) {
    warnClaudeProfile(report, name, result.failed[0])
  }
  if (result.retained) {
    warnClaudeProfile(
      report,
      name,
      new ClaudeProfileSurfaceError(
        'retained-conflict',
        `${result.retained} conflicting entries kept in ${pendingPath}`
      )
    )
  }
}
