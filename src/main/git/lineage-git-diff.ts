import fs from 'node:fs'
import path from 'node:path'
import { getDiff } from './status'
import { gitExecFileAsync } from './runner'
import { gitOptionsForWorktree } from './git-runtime-options'
import type {
  LineageGetFileDiffArgs,
  LineageGetFileDiffResult
} from '../../shared/fleet-lineage-types'

export async function getLineageFileDiff(
  args: LineageGetFileDiffArgs,
  context?: {
    resolveWorktreePath?: (worktreeId: string) => string | undefined
  }
): Promise<LineageGetFileDiffResult> {
  const { childWorktreeId, filePath, staged } = args
  let worktreePath = args.worktreePath

  if (!worktreePath && childWorktreeId && context?.resolveWorktreePath) {
    worktreePath = context.resolveWorktreePath(childWorktreeId)
  }

  if (!worktreePath) {
    return {
      status: 404,
      patch: '',
      original: '',
      modified: '',
      error: `Worktree path could not be resolved for worktree: ${childWorktreeId}`
    }
  }

  const fullPath = path.resolve(worktreePath, filePath)

  // AC 13 / C14: dependency failure - non-existent file returns 404 without crashing backend
  if (!staged && !fs.existsSync(fullPath)) {
    return {
      status: 404,
      patch: '',
      original: '',
      modified: '',
      error: `File not found: ${filePath}`
    }
  }

  try {
    let patch = ''
    try {
      const diffArgs = staged ? ['diff', '--cached', '--', filePath] : ['diff', '--', filePath]
      const diffExec = await gitExecFileAsync(diffArgs, gitOptionsForWorktree(worktreePath))
      patch = diffExec.stdout || ''
    } catch {
      // Fallback patch header if git diff exec has non-zero exit or empty
      patch = `--- a/${filePath}\n+++ b/${filePath}\n`
    }

    const diff = await getDiff(worktreePath, filePath, staged)

    if (!diff) {
      return {
        status: 404,
        patch: '',
        original: '',
        modified: '',
        error: `Diff not found for file: ${filePath}`
      }
    }

    const original = diff.originalContent ?? ''
    const modified = diff.modifiedContent ?? ''

    return {
      status: 200,
      patch,
      original,
      modified
    }
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    const message = error instanceof Error ? error.message : ''
    if (code === 'ENOENT' || message.includes('not found') || message.includes('does not exist')) {
      return {
        status: 404,
        patch: '',
        original: '',
        modified: '',
        error: message || `File not found: ${filePath}`
      }
    }

    return {
      status: 500,
      patch: '',
      original: '',
      modified: '',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
