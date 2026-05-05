import { z } from 'zod'

export type RpcRequest = {
  id: string
  deviceToken: string
  method: string
  params?: unknown
}

export type RpcSuccess = {
  id: string
  ok: true
  result: unknown
  streaming?: true
  _meta: { runtimeId: string }
}

export type RpcFailure = {
  id: string
  ok: false
  error: { code: string; message: string; data?: unknown }
  _meta: { runtimeId: string }
}

export type RpcResponse = RpcSuccess | RpcFailure

export const PAIRING_OFFER_VERSION = 2

export const PairingOfferSchema = z.object({
  v: z.literal(PAIRING_OFFER_VERSION),
  endpoint: z.string().min(1),
  deviceToken: z.string().min(1),
  publicKeyB64: z.string().min(1)
})

export type PairingOffer = z.infer<typeof PairingOfferSchema>

export type ConnectionState =
  | 'connecting'
  | 'handshaking'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'auth-failed'

export type HostProfile = {
  id: string
  name: string
  endpoint: string
  deviceToken: string
  publicKeyB64: string
  lastConnected: number
}

export const HostProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  endpoint: z.string().min(1),
  deviceToken: z.string().min(1),
  publicKeyB64: z.string().min(1),
  lastConnected: z.number().finite()
})
