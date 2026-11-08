import type { RuntimeWorktreeRecord } from '../shared/runtime-types'
import { parseWorkspaceKey } from '../shared/workspace-scope'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime/types'

export function mayNameFolderWorkspace(selector: string): boolean {
  return selector.startsWith('path:') || selector.startsWith('name:')
}

/**
 * path: and name: also name folder workspaces. The runtime's matcher (opted in) answers with the
 * folder's key, which every command accepts; an older runtime ignores the opt-in and keeps its
 * repo-only meaning. Only an ambiguity is final here; the command reports any other miss itself.
 */
export async function resolveFolderWorkspaceSelector(
  selector: string,
  client: RuntimeClient
): Promise<string> {
  if (!mayNameFolderWorkspace(selector)) {
    return selector
  }
  try {
    const shown = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
      worktree: selector,
      matchFolderWorkspaces: true
    })
    const { id } = shown.result.worktree
    return parseWorkspaceKey(id)?.type === 'folder' ? id : selector
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'selector_ambiguous') {
      throw error
    }
    return selector
  }
}
