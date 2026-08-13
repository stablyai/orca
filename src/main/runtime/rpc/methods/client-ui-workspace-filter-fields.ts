import { z } from 'zod'

export const ClientUiWorkspaceFilterFields = {
  hideDefaultBranchWorkspace: z.boolean().optional(),
  hideAutomationGeneratedWorkspaces: z.boolean().optional(),
  hideCliCreatedWorkspaces: z.boolean().optional(),
  hideDetachedHeadWorkspaces: z.boolean().optional(),
  hideWorkspacesFromOtherDevices: z.boolean().optional(),
  alwaysShowDefaultBranchWorkspace: z.boolean().optional(),
  hiddenWorkspaceStatusIds: z.array(z.string()).optional(),
  filterRepoIds: z.array(z.string()).optional()
}
