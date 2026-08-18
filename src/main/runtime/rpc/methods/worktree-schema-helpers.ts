import { z } from 'zod'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { normalizeExecutionHostId } from '../../../../shared/execution-host'
import { OptionalString } from '../schemas'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../../../shared/workspace-linked-item-source-context'
import type { WorkspaceLinkedItemSchema } from '../../../../shared/workspace-linked-item-schema'
import type { TaskSourceContextSchema } from '../../../../shared/task-source-context-schema'

export const OptionalExecutionHostId = z
  .string()
  .transform((value, ctx) => {
    const hostId = normalizeExecutionHostId(value)
    if (!hostId) {
      ctx.addIssue({ code: 'custom', message: 'Invalid host id' })
      return z.NEVER
    }
    return hostId
  })
  .optional()

export const OptionalTuiAgent = z
  .unknown()
  .superRefine((value, ctx) => {
    if (value !== undefined && !isTuiAgent(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unknown TUI agent' })
    }
  })
  .transform((value): TuiAgent | undefined => (isTuiAgent(value) ? value : undefined))
  .optional()

export const AutomationWorkspaceProvenanceRequest = z.object({
  automationId: z.string(),
  automationRunId: z.string(),
  dispatchToken: z.string(),
  createRequestId: z.string()
})

// Why no dispatch token (unlike automation provenance): this is a descriptive
// origin marker for sidebar filtering, not an authority grant. The host stamps
// createdAt itself so a client clock can't skew sort order.
export const CliWorkspaceProvenanceRequest = z.object({
  callerTerminalHandle: OptionalString
})

/** Shared by WorktreeCreate and WorktreeSet so the two error messages cannot drift. */
export function assertLinkedWorkItemSourceContextMatch(
  params: {
    linkedWorkItem?: z.infer<typeof WorkspaceLinkedItemSchema> | null
    linkedTaskSourceContext?: z.infer<typeof TaskSourceContextSchema> | null
  },
  ctx: z.RefinementCtx
): void {
  if (
    params.linkedWorkItem &&
    params.linkedTaskSourceContext &&
    !isWorkspaceLinkedItemSourceContextMatch(params.linkedWorkItem, params.linkedTaskSourceContext)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Linked work item and source context identities must match'
    })
  }
}
