import { z } from 'zod'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'

const hostId = z.string().transform((value, ctx) => {
  const parsed = normalizeExecutionHostId(value)
  if (parsed) {
    return parsed
  }
  ctx.addIssue({ code: 'custom', message: 'Invalid execution host' })
  return z.NEVER
})
export const ownerSelectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('self') }),
  z.object({
    kind: z.literal('ssh'),
    targetId: z.string().min(1),
    targetGeneration: z.number().int().positive()
  }),
  z.object({ kind: z.literal('orphan'), issue: z.string() })
])
export const automationSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  prompt: z.string(),
  // Open so a newer host's agent or surface keeps its row: the phone never writes the surface,
  // and the host validates the agent on every write.
  agentId: z.string().min(1),
  surface: z.string().optional(),
  projectId: z.string(),
  workspaceMode: z.enum(['existing', 'new_per_run']),
  workspaceId: z.string().nullable(),
  enabled: z.boolean(),
  timezone: z.string(),
  rrule: z.string(),
  dtstart: z.number(),
  nextRunAt: z.number(),
  baseBranch: z.string().nullable(),
  reuseSession: z.boolean(),
  precheck: z.object({ command: z.string(), timeoutSeconds: z.number() }).nullable(),
  extraAgentArgs: z.string().optional(),
  setupDecision: z.enum(['inherit', 'run', 'skip']).optional(),
  missedRunGraceMinutes: z.number(),
  runContext: z
    .object({
      kind: z.literal('workspace-run'),
      projectId: z.string(),
      hostId,
      projectHostSetupId: z.string(),
      repoId: z.string(),
      path: z.string()
    })
    .nullish()
})
const ownerItemSchema = z.object({
  automationId: z.string().min(1),
  selector: ownerSelectorSchema,
  // An unreadable summary reads as none, as on desktop, so it never costs the row.
  usageSummary: salvagedOptional(
    'usageSummary',
    z.object({ lastRunStatus: z.string().nullish(), lastRunAt: z.number().nullish() }).nullable()
  )
})
// Read row by row like the desktop reader: a row this build can't read is left out, never the list.
export const automationListSchema = z
  .object({
    automations: salvagingArray(automationSchema),
    items: salvagingArray(ownerItemSchema)
  })
  .transform((reply) => {
    // Only exactly one readable owner attributes a row to this host; duplicates leave the row out.
    const owners = new Map<string, z.output<typeof ownerItemSchema> | null>()
    for (const item of reply.items) {
      owners.set(item.automationId, owners.has(item.automationId) ? null : item)
    }
    return reply.automations.flatMap((automation) => {
      const item = owners.get(automation.id)
      return item ? [{ automation, item }] : []
    })
  })
export const runSchema = z.looseObject({
  id: z.string().min(1),
  automationId: z.string(),
  title: z.string(),
  status: z.string(),
  trigger: z.string(),
  scheduledFor: z.number(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  dispatchedAt: z.number().nullable(),
  workspaceId: z.string().nullable(),
  workspaceDisplayName: z.string().nullish(),
  terminalPaneKey: z.string().nullable(),
  terminalPtyId: z.string().nullable(),
  error: z.string().nullable(),
  errorCode: z.string().nullish(),
  errorParams: z.record(z.string(), z.union([z.string(), z.number()])).nullish(),
  outputSnapshot: z
    .object({ content: z.string(), capturedAt: z.number(), truncated: z.boolean() })
    .nullable(),
  precheckResult: z
    .object({ stdout: z.string(), stderr: z.string(), command: z.string() })
    .nullable(),
  usage: z.object({ unavailableMessage: z.string().nullish() }).nullable(),
  // Display-only, so a newer host kind shows by its id instead of costing the run.
  runContext: z.object({ hostId: z.string(), repoId: z.string(), path: z.string() }).nullish()
})
const readableRuns = salvagingArray(runSchema)
export const runsPageSchema = z
  .object({ runs: z.array(z.unknown()), nextCursor: z.string().nullish() })
  .transform(({ runs, nextCursor }) => {
    const readable = readableRuns.parse(runs)
    // Derived on decode: a run this build can't read is still in the host's history.
    return { runs: readable, nextCursor, unreadableRuns: runs.length - readable.length }
  })
export const projectInventorySchema = z.object({
  projects: salvagingArray(
    z.object({ id: z.string(), displayName: z.string(), kind: z.string().optional() })
  )
})
export const setupInventorySchema = z.object({
  setups: salvagingArray(
    z.object({
      id: z.string(),
      projectId: z.string(),
      hostId,
      repoId: z.string(),
      path: z.string(),
      displayName: z.string(),
      kind: z.string().optional(),
      setupState: z.string()
    })
  )
})
export const workspaceSchema = z.object({
  worktreeId: z.string(),
  repoId: z.string(),
  displayName: z.string(),
  path: z.string(),
  hostId: hostId.optional(),
  workspaceKind: z.string().optional(),
  isArchived: z.boolean().optional()
})
export const sshInventorySchema = z.object({
  targets: salvagingArray(
    z.object({
      id: z.string(),
      label: z.string(),
      generation: z.number().int().positive().optional()
    })
  )
})
export type MobileAutomation = z.output<typeof automationSchema>
export type MobileAutomationRow = z.output<typeof automationListSchema>[number]
export type MobileAutomationRun = z.output<typeof runSchema>
export type AutomationSetup = z.output<typeof setupInventorySchema>['setups'][number]
export type AutomationWorkspace = z.output<typeof workspaceSchema>
