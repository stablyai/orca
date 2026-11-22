import { EpochMsSchema } from '@orca-cloud/push-contract'
import { z } from 'zod'

// Why the agent couldn't do what was asked, as the machine read it from the agent's own typed signals
// (never its text). A category this cloud doesn't know reads as agent_error.
export const CONNECTOR_FAILURE_CATEGORIES = [
  'signed_out',
  'usage_limit',
  'not_set_up',
  'folder_missing',
  'agent_error',
  // The machine lost track of the request (a restart it can't account for): it may have finished.
  'unconfirmed'
] as const
export type ConnectorFailureCategory = (typeof CONNECTOR_FAILURE_CATEGORIES)[number]

export const ConnectorFailureSchema = z.object({
  category: z.string().min(1).max(64),
  // The agent's display name, e.g. "Codex".
  agentName: z.string().min(1).max(64).optional(),
  // Present only when the agent said which limit, or when it resets.
  usageLimit: z
    .object({ window: z.string().min(1).max(32).optional(), resetsAt: EpochMsSchema.optional() })
    .optional(),
  // The machine's IANA time zone, for sources that can't show a time in each reader's own.
  timeZone: z.string().min(1).max(64).optional()
})
export type ConnectorFailure = z.infer<typeof ConnectorFailureSchema>

// Optional and additive: one a peer can't read is dropped, never the message carrying it.
export const OptionalConnectorFailureSchema = ConnectorFailureSchema.optional().catch(undefined)

export function connectorFailureCategory(failure: ConnectorFailure): ConnectorFailureCategory {
  return CONNECTOR_FAILURE_CATEGORIES.find((known) => known === failure.category) ?? 'agent_error'
}
