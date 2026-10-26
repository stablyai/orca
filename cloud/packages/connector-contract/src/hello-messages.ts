import { SequenceSchema } from '@orca-cloud/push-contract'
import { z } from 'zod'
import { CONNECTOR_LIMITS } from './connector-limits.js'
import { ConnectorHostDescription, PlaceIdSchema } from './connector-wire-scalars.js'

export const CONNECTOR_AGENTS = ['claude', 'codex'] as const
export const CONNECTOR_PROMPT_KINDS = ['approval', 'question'] as const
export const CONNECTOR_FEATURES = ['answer', 'cancel', 'reply'] as const

// The cloud uses only what a machine lists; an entry it does not know is ignored, not refused.
const CapabilityList = z.array(z.string().min(1))

// Display strings are capped so a hello's size is predictable; the machine shortens longer ones.
const DisplayText = z.string().min(1).max(CONNECTOR_LIMITS.maxDisplayTextLength)

export const ConnectorProjectSchema = z.object({
  placeId: PlaceIdSchema,
  name: DisplayText,
  // Never a path: "owner/name" when the project has a known remote.
  remote: DisplayText.optional(),
  kind: z.enum(['git', 'folder']),
  where: z.object({
    kind: z.enum(['local', 'ssh', 'wsl']),
    label: DisplayText.optional()
  })
})

export const ConnectorHelloRequestSchema = z.object({
  v: z.literal(1),
  contract: z.number().int().positive(),
  ...ConnectorHostDescription,
  agents: CapabilityList,
  promptKinds: CapabilityList,
  features: CapabilityList,
  // The cloud sends a conversation only to a machine that lists its source.
  sources: CapabilityList,
  projects: z.array(ConnectorProjectSchema).max(CONNECTOR_LIMITS.maxHelloProjects)
})

// Every hello gets a revision above every earlier one for this machine, assigned by the cloud. Polls, acks
// and events carry it; under an older one they get 409 hello_required.
export const ConnectorHelloResponseSchema = z.object({ helloRev: SequenceSchema })

export type ConnectorProject = z.infer<typeof ConnectorProjectSchema>
export type ConnectorHelloRequest = z.infer<typeof ConnectorHelloRequestSchema>
export type ConnectorHelloResponse = z.infer<typeof ConnectorHelloResponseSchema>
