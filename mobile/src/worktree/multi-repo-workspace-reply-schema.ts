import { z } from 'zod'

export const multiRepoRetryReplySchema = z.object({ folderWorkspace: z.unknown() })

export const multiRepoDeleteInspectionSchema = z.object({
  folderWorkspaceId: z.string(),
  members: z.array(
    z.object({
      memberId: z.string(),
      repoId: z.string(),
      state: z.string(),
      worktreeId: z.string().nullable(),
      worktreeExists: z.boolean(),
      dirtyCount: z.number().nullable(),
      unpublishedCommitCount: z.number().nullable(),
      willKeepBranch: z.boolean().nullable()
    })
  ),
  rootPath: z.string(),
  rootOwnedByOrca: z.boolean()
})

export const multiRepoDeleteResultSchema = z.object({
  folderWorkspaceId: z.string(),
  members: z.array(
    z.discriminatedUnion('status', [
      z.object({
        memberId: z.string(),
        status: z.literal('removed'),
        preservedBranch: z.string().optional()
      }),
      z.object({ memberId: z.string(), status: z.literal('dropped') }),
      z.object({
        memberId: z.string(),
        status: z.literal('failed'),
        code: z.string(),
        message: z.string()
      })
    ])
  ),
  workspaceRemoved: z.boolean(),
  rootKept: z
    .object({
      path: z.string(),
      reason: z.enum(['not_empty', 'not_owned', 'remove_failed'])
    })
    .optional(),
  remainingMemberCount: z.number()
})

export type MultiRepoDeleteInspectionReply = z.output<typeof multiRepoDeleteInspectionSchema>
export type MultiRepoDeleteResultReply = z.output<typeof multiRepoDeleteResultSchema>

export const multiRepoSiblingListSchema = z.object({
  folderWorkspaces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      multiRepo: z
        .object({
          members: z.array(
            z.object({
              memberId: z.string(),
              dirName: z.string(),
              state: z.string(),
              worktreeId: z.string().optional()
            })
          )
        })
        .optional()
    })
  )
})

export type MultiRepoSiblingList = z.output<typeof multiRepoSiblingListSchema>
