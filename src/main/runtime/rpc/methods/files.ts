import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'

const WorktreeSelector = z.object({
  worktree: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing worktree selector'))
})

const FileOpen = WorktreeSelector.extend({
  relativePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing relative path'))
})

export const FILE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'files.list',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.listMobileFiles(params.worktree)
  }),
  defineMethod({
    name: 'files.open',
    params: FileOpen,
    handler: async (params, { runtime }) =>
      runtime.openMobileFile(params.worktree, params.relativePath)
  }),
  defineMethod({
    name: 'files.read',
    params: FileOpen,
    handler: async (params, { runtime }) =>
      runtime.readMobileFile(params.worktree, params.relativePath)
  })
]
