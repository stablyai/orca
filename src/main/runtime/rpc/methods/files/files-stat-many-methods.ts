import { defineMethod } from '../../core'
import { FileStatMany } from '../../../../../shared/rpc-contract/files-params'

/** Batched stat for cloud file sync manifests (one call instead of one per file). */
export const FILE_STAT_MANY_METHODS = [
  defineMethod({
    name: 'files.statMany',
    permission: 'workspace',
    params: FileStatMany,
    handler: async (params, { runtime }) =>
      runtime.statManyRuntimeFiles(params.worktree, params.relativePaths)
  })
]
