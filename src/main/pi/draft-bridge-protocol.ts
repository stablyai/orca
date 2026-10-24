import { z } from 'zod'

/** Files exchanged with the in-agent bridge process; versioned independently of the RPC surface. */
export const PI_DRAFT_BRIDGE_PROTOCOL = 1

export const PiDraftBridgeSessionSchema = z.looseObject({
  protocol: z.number().int(),
  token: z.string().min(1),
  paneKey: z.string(),
  createdAt: z.number().finite()
})

export const PiDraftBridgeHelloSchema = z.looseObject({
  protocol: z.number().int(),
  token: z.string().min(1),
  instanceId: z.string().min(1),
  pid: z.number().int().positive(),
  sessionId: z.string().optional(),
  startedAt: z.number().finite(),
  at: z.number().finite(),
  capabilities: z.looseObject({
    capture: z.boolean().optional(),
    replace: z.boolean().optional()
  })
})

export const PiDraftBridgeResponseSchema = z.looseObject({
  protocol: z.number().int(),
  token: z.string().min(1),
  id: z.string().min(1),
  ok: z.boolean(),
  text: z.string().optional(),
  sourceToken: z.string().optional(),
  error: z.enum(['conflict', 'invalid', 'unavailable']).optional(),
  normalized: z.boolean().optional()
})

export type PiDraftBridgeSession = z.infer<typeof PiDraftBridgeSessionSchema>
export type PiDraftBridgeHello = z.infer<typeof PiDraftBridgeHelloSchema>
export type PiDraftBridgeResponse = z.infer<typeof PiDraftBridgeResponseSchema>

export type PiDraftBridgeRequest = {
  protocol: number
  token: string
  id: string
  op: 'capture' | 'replace'
  text?: string
  baseToken?: string
}
