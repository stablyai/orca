import { z } from 'zod'

export const MissionCreateArgs = z.object({
  name: z.string().min(1),
  branchName: z.string().min(1).optional(),
  repoIds: z.array(z.string().min(1)).min(1)
})

export const MissionUpdateArgs = z.object({
  missionId: z.string().min(1),
  updates: z.object({
    name: z.string().optional(),
    tabOrder: z.number().finite().optional()
  })
})

export const MissionDeleteArgs = z.object({
  missionId: z.string().min(1),
  deleteWorktrees: z.boolean()
})

export const MissionAddMembersArgs = z.object({
  missionId: z.string().min(1),
  repoIds: z.array(z.string().min(1)).min(1)
})

export const MissionRemoveMemberArgs = z.object({
  missionId: z.string().min(1),
  repoId: z.string().min(1),
  deleteWorktree: z.boolean()
})

export const MissionMemberSelectorArgs = z.object({
  missionId: z.string().min(1),
  repoId: z.string().min(1)
})

export const MissionSelectorArgs = z.object({
  missionId: z.string().min(1)
})

export function parseMissionIpcArgs<T>(schema: z.ZodType<T>, value: unknown, errorCode: string): T {
  const result = schema.safeParse(value)
  if (result.success) {
    return result.data
  }
  throw new Error(errorCode)
}
