import type { CreateWorktreeArgs } from '../../../shared/worktree/create-types'
import type {
  AutomationWorkspaceProvenance,
  CliWorkspaceProvenance
} from '../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { NestedWorktreeRemovalApproval } from '../../../shared/worktree/nested-removal'
import type { ListDetectedWorktreesArgs } from '../../../shared/detected-worktree-provider-contract'
import { WorkspaceLinkedItemSchema } from '../../../shared/workspace-linked-item-schema'
import { WorkspaceAttachmentsSchema } from '../../../shared/workspace-attachment-schema'
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
  approvedNestedWorktrees?: NestedWorktreeRemovalApproval[]
  expectedCheckout?: NestedWorktreeRemovalApproval
  /** Explicit Force Delete only — `force` alone is set by the ordinary confirmation (#11960). */
  allowUnverifiedPtyStop?: boolean
  skipArchive?: boolean
  /** Explicit waiver for a FAILED archive hook (#19334). Distinct from `skipArchive`, which
   *  never runs the hook at all, and never implied by `force`. */
  allowFailedArchiveHook?: boolean
  snapshotPruneBatchId?: string
}

export type DetectedWorktreeRequestArgs = { repoId: string } | ListDetectedWorktreesArgs

export const NullableWorkspaceLinkedItemSchema = WorkspaceLinkedItemSchema.nullable()
export const NullableTaskSourceContextSchema = TaskSourceContextSchema.nullable()

export function normalizeLinkedWorkItemFields<
  T extends {
    linkedWorkItem?: unknown
    linkedItems?: unknown
    linkedItemsBase?: unknown
    linkedItemsSelectionChanged?: boolean
    linkedTaskSourceContext?: unknown
  }
>(input: T): T {
  if (
    input.linkedItemsSelectionChanged !== undefined &&
    typeof input.linkedItemsSelectionChanged !== 'boolean'
  ) {
    throw new Error('Invalid attachment selection mutation')
  }
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
    ...(input.linkedItems !== undefined
      ? { linkedItems: WorkspaceAttachmentsSchema.parse(input.linkedItems) }
      : {}),
    ...(input.linkedItemsBase !== undefined
      ? { linkedItemsBase: WorkspaceAttachmentsSchema.parse(input.linkedItemsBase) }
      : {}),
    ...(linkedWorkItem !== undefined ? { linkedWorkItem } : {}),
    ...(linkedTaskSourceContext !== undefined ? { linkedTaskSourceContext } : {})
  }
}
