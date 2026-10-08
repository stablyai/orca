import { z } from 'zod'

/**
 * The terminal a create launches on its execution host, recorded with the claim before dispatch.
 * Identity only: the launch plan is re-derived by every attempt that may spawn, so no prompt, env
 * or command reaches disk, and this shape never follows the RPC params.
 */
const AgentSessionCreateTerminalTargetSchema = z.object({
  version: z.literal(1),
  executionOperationId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  worktreeId: z.string().min(1),
  connectionId: z.string().nullable(),
  terminalHandle: z.string().min(1),
  tabId: z.string().min(1),
  leafId: z.string().min(1)
})

export type AgentSessionCreateTerminalTarget = z.infer<
  typeof AgentSessionCreateTerminalTargetSchema
>

/** Strips anything outside the schema, so only identity is ever persisted. */
export function toAgentSessionCreateTerminalTarget(
  target: Omit<AgentSessionCreateTerminalTarget, 'version'>
): AgentSessionCreateTerminalTarget {
  return AgentSessionCreateTerminalTargetSchema.parse({ ...target, version: 1 })
}

export function readAgentSessionCreateTerminalTarget(
  value: unknown
): AgentSessionCreateTerminalTarget | null {
  const parsed = AgentSessionCreateTerminalTargetSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
