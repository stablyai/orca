import { z } from 'zod'
import { isValidGitBranchName } from '../../shared/git-branch-name'
import { isTuiAgent } from '../../shared/tui-agent-config'

export const MissionCreateArgs = z.object({
  name: z.string().min(1),
  // Why: reject untrusted IPC before Store.createMission can persist an unusable Mission.
  branchName: z
    .string()
    .min(1)
    .refine((value) => !value.trim() || isValidGitBranchName(value.trim()))
    .optional(),
  repoIds: z.array(z.string().min(1)).min(1),
  sessionAgent: z.string().refine(isTuiAgent).optional()
})

export const MissionUpdateArgs = z.object({
  missionId: z.string().min(1),
  updates: z.object({
    name: z.string().min(1).optional(),
    tabOrder: z.number().optional()
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
