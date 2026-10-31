import { z } from 'zod'
import { isTuiAgent } from '../../../src/shared/tui-agent-config'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'

const hostId = z.string().transform((value, ctx) => {
  const parsed = normalizeExecutionHostId(value)
  if (parsed) {
    return parsed
  }
  ctx.addIssue({ code: 'custom', message: 'Invalid execution host' })
  return z.NEVER
})
const agentId = z.custom<TuiAgent>(isTuiAgent)
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
  agentId,
  surface: z.enum(['chat', 'terminal']).optional(),
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
export const automationListSchema = z
  .object({
    automations: z.array(automationSchema),
    items: z.array(
      z.object({
        automationId: z.string().min(1),
        selector: ownerSelectorSchema,
        usageSummary: z
          .object({ lastRunStatus: z.string().nullish(), lastRunAt: z.number().nullish() })
          .nullish()
      })
    )
  })
  .transform((reply, ctx) => {
    const owners = new Map(reply.items.map((item) => [item.automationId, item]))
    if (
      owners.size !== reply.items.length ||
      reply.automations.some((entry) => !owners.has(entry.id))
    ) {
      ctx.addIssue({ code: 'custom', message: 'Automation ownership is missing or ambiguous' })
      return z.NEVER
    }
    return reply.automations.map((automation) => ({
      automation,
      // The check above proves presence without attributing an unqualified row to this host.
      item: owners.get(automation.id)!
    }))
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
  runContext: z.object({ hostId, repoId: z.string(), path: z.string() }).nullish()
})
export const runsPageSchema = z.object({
  runs: z.array(runSchema),
  nextCursor: z.string().nullish()
})
export const projectInventorySchema = z.object({
  projects: z.array(
    z.object({ id: z.string(), displayName: z.string(), kind: z.string().optional() })
  )
})
export const setupInventorySchema = z.object({
  setups: z.array(
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
  targets: z.array(
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
