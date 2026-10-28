import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../shared/workspace-scope'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  isWorktreeHostIdentity
} from '../../shared/worktree/host-qualified-identity'

export type ConditionalWorkspaceMatch = 'same' | 'different' | 'unknown'

export function createConditionalWorkspaceMatcher(workspaceId: string, executionHostId: string) {
  const expected = splitWorktreeIdForFilesystem(workspaceId)
  const paths = new Map<string, string | null>()
  const physicalPath = (path: string): string | null => {
    if (paths.has(path)) {
      return paths.get(path) ?? null
    }
    let canonical: string | null = null
    try {
      if (isAbsolute(path)) {
        const directory = statSync(realpathSync.native(path), { bigint: true })
        if (directory.isDirectory()) {
          canonical = `${directory.dev}:${directory.ino}`
        }
      }
    } catch {
      // Unresolvable saved identities cannot prove absence.
    }
    paths.set(path, canonical)
    return canonical
  }
  return (candidateId: string, candidateHostId: string | undefined): ConditionalWorkspaceMatch => {
    if (!candidateHostId) {
      return 'unknown'
    }
    if (
      isWorktreeHostIdentity(candidateId) &&
      getExecutionHostIdFromWorktreeHostIdentity(candidateId) !== candidateHostId
    ) {
      return 'unknown'
    }
    if (candidateHostId !== executionHostId) {
      return 'different'
    }
    candidateId = normalizeWorkspaceSessionKeyToWorkspaceId(candidateId)
    if (candidateId === workspaceId) {
      return 'same'
    }
    const candidate = splitWorktreeIdForFilesystem(candidateId)
    if (!expected || !candidate) {
      return 'unknown'
    }
    const left = physicalPath(expected.worktreePath)
    const right = physicalPath(candidate.worktreePath)
    if (left === null || right === null) {
      return 'unknown'
    }
    return left === right ? 'same' : 'different'
  }
}
