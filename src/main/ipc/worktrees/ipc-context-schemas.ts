import type { CreateWorktreeArgs } from '../../../shared/worktree/create-types'
import type {
  AutomationWorkspaceProvenance,
  CliWorkspaceProvenance
} from '../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { ListDetectedWorktreesArgs } from '../../../shared/detected-worktree-provider-contract'
import { WorkspaceLinkedItemSchema } from '../../../shared/workspace-linked-item-schema'
import { TaskSourceContextSchema } from '../../../shared/task-source-context-schema'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../../shared/workspace-linked-item-source-context'

export type CreateWorktreeArgsWithSystemProvenance = CreateWorktreeArgs & {
  automationProvenance?: AutomationWorkspaceProvenance
  cliProvenance?: CliWorkspaceProvenance
}

export type RemoveWorktreeArgs = {
  worktreeId: string
  hostId?: ExecutionHostId
  force?: boolean
  /** Explicit Force Delete only — `force` alone is set by the ordinary confirmation (#11960). */
  allowUnverifiedPtyStop?: boolean
  skipArchive?: boolean
  snapshotPruneBatchId?: string
}

export type DetectedWorktreeRequestArgs = { repoId: string } | ListDetectedWorktreesArgs

export const NullableWorkspaceLinkedItemSchema = WorkspaceLinkedItemSchema.nullable()
export const NullableTaskSourceContextSchema = TaskSourceContextSchema.nullable()

export function normalizeLinkedWorkItemFields<
  T extends {
    linkedWorkItem?: unknown
    linkedTaskSourceContext?: unknown
  }
>(input: T): T {
  const linkedWorkItem =
    input.linkedWorkItem === undefined
      ? undefined
      : NullableWorkspaceLinkedItemSchema.parse(input.linkedWorkItem)
  const linkedTaskSourceContext =
    input.linkedTaskSourceContext === undefined
      ? undefined
      : NullableTaskSourceContextSchema.parse(input.linkedTaskSourceContext)
  if (
    linkedWorkItem &&
    linkedTaskSourceContext &&
    !isWorkspaceLinkedItemSourceContextMatch(linkedWorkItem, linkedTaskSourceContext)
  ) {
    throw new Error('Linked work item and source context identities must match')
  }
  return {
    ...input,
    ...(linkedWorkItem !== undefined ? { linkedWorkItem } : {}),
    ...(linkedTaskSourceContext !== undefined ? { linkedTaskSourceContext } : {})
  }
}
