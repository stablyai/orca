import { defineMethod, type RpcMethod } from '../core'
import { WorktreeSelector } from './worktree-schemas'

/** Explicit import/unimport of worktrees Orca did not create. Both operations
 *  only edit the owning repo's import list — no checkout is created, moved, or
 *  removed, and no Orca authorship metadata is written (#10671). */
export const WORKTREE_IMPORT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'worktree.import',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.importExternalWorktree(params.worktree)
  }),
  defineMethod({
    name: 'worktree.unimport',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.unimportExternalWorktree(params.worktree)
  })
]
