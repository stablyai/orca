import { SequenceSchema } from '@orca-cloud/push-contract'
import { z } from 'zod'
import { ConnectorHostDescription, PlaceIdSchema } from './connector-wire-scalars.js'

export const CONNECTOR_AGENTS = ['claude', 'codex'] as const
export const CONNECTOR_PROMPT_KINDS = ['approval', 'question'] as const
export const CONNECTOR_FEATURES = ['answer', 'cancel', 'reply'] as const

// The cloud uses only what a machine lists; an entry it does not know is ignored, not refused.
const CapabilityList = z.array(z.string().min(1))

export const ConnectorProjectSchema = z.object({
  placeId: PlaceIdSchema,
  name: z.string().min(1),
  // Never a path: "owner/name" when the project has a known remote.
  remote: z.string().min(1).optional(),
  kind: z.enum(['git', 'folder']),
  where: z.object({
    kind: z.enum(['local', 'ssh', 'wsl']),
    label: z.string().min(1).optional()
  })
})

export const ConnectorHelloRequestSchema = z.object({
  v: z.literal(1),
  // Rises across restarts on one install (the machine sends max(previous + 1, now in ms)), so the cloud
  // never keeps an older process's hello over a newer one.
  helloRev: SequenceSchema,
  contract: z.number().int().positive(),
  ...ConnectorHostDescription,
  agents: CapabilityList,
  promptKinds: CapabilityList,
  features: CapabilityList,
  projects: z.array(ConnectorProjectSchema)
})

export type ConnectorProject = z.infer<typeof ConnectorProjectSchema>
export type ConnectorHelloRequest = z.infer<typeof ConnectorHelloRequestSchema>
