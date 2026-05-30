import { open, stat } from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import type { Store } from './persistence'
import {
  readClaudeWorkflowDetail,
  type ClaudeWorkflowDetail,
  type ClaudeWorkflowDetailTarget
} from '../shared/claude-workflow-detail'
import { splitWorktreeIdForFilesystem } from '../shared/worktree-id'

async function readLocalPreview(
  filePath: string,
  maxBytes: number
): Promise<{ content: string; bytesRead: number; truncated: boolean; mtimeMs?: number }> {
  let handle: FileHandle | null = null
  try {
    const info = await stat(filePath)
    const bytesToRead = Math.min(Math.max(maxBytes, 0), info.size)
    const offset = Math.max(0, info.size - bytesToRead)
    handle = await open(filePath, 'r')
    const buffer = Buffer.alloc(bytesToRead)
    const result = await handle.read(buffer, 0, bytesToRead, offset)
    return {
      content: buffer.subarray(0, result.bytesRead).toString('utf8'),
      bytesRead: result.bytesRead,
      truncated: info.size > bytesToRead,
      mtimeMs: info.mtimeMs
    }
  } finally {
    await handle?.close()
  }
}

function resolveWorktreeTarget(
  store: Store,
  target: ClaudeWorkflowDetailTarget
): ClaudeWorkflowDetailTarget {
  const parsed = splitWorktreeIdForFilesystem(target.worktreeId)
  if (!parsed) {
    throw new Error('Invalid worktree target.')
  }
  const repo = store.getRepo(parsed.repoId)
  if (!repo) {
    throw new Error('Unknown worktree target.')
  }
  const expectedConnectionId = repo.connectionId ?? null
  if (expectedConnectionId !== target.connectionId) {
    throw new Error('Workflow target connection changed.')
  }
  // Why: renderer-provided paths are selectors only. The owning worktree path
  // is re-derived from the durable worktree id before any file read.
  return { ...target, worktreePath: parsed.worktreePath, connectionId: expectedConnectionId }
}

export async function getClaudeWorkflowDetail(
  store: Store,
  target: ClaudeWorkflowDetailTarget
): Promise<ClaudeWorkflowDetail> {
  const resolvedTarget = resolveWorktreeTarget(store, target)
  const io = resolvedTarget.connectionId
    ? null
    : {
        readPreview: readLocalPreview,
        stat: async (filePath: string) => {
          const info = await stat(filePath)
          return { mtimeMs: info.mtimeMs, size: info.size }
        }
      }
  return readClaudeWorkflowDetail(resolvedTarget, io)
}
