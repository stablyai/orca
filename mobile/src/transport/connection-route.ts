import { z } from 'zod'

export const SshJumpRouteSchema = z.object({
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[^\s/@?#]+$/),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(256),
  hostKeyFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
  // The jump profile's credential id: its own stored secret authenticates it.
  credentialId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/)
})

// One SSH connection (optionally through a jump profile) plus the socket
// destination dialed from that server (ssh -L semantics): this describes the
// route, never the temporary listening port or authentication secret.
export const SshConnectionRouteSchema = z.object({
  kind: z.literal('ssh'),
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[^\s/@?#]+$/),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(256),
  // Resolved by the SSH server, so names unknown to the phone work here.
  targetHost: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[^\s/@?#]+$/),
  targetPort: z.number().int().min(1).max(65535),
  hostKeyFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
  credentialId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),
  jump: SshJumpRouteSchema.optional()
})

export const ConnectionRouteSchema = SshConnectionRouteSchema
export type ConnectionRoute = z.infer<typeof ConnectionRouteSchema>

export type ConnectionRouteStage = {
  code: string
  message: string
}

export type ConnectionRouteLease = {
  endpoint: string
  // Native stage log (dial, auth, jump channel, listener) for diagnostics.
  stages?: ConnectionRouteStage[]
  close(): void
}

export type ConnectionRouteProvider = {
  open(endpoint: string, signal: AbortSignal): Promise<ConnectionRouteLease>
}

export class ConnectionRouteError extends Error {
  // Native stage log collected before the failure, for diagnostics.
  readonly stages?: ConnectionRouteStage[]

  constructor(
    message: string,
    readonly retryable: boolean,
    stages?: ConnectionRouteStage[]
  ) {
    super(message)
    this.name = 'ConnectionRouteError'
    this.stages = stages
  }
}

// React Native's AbortSignal polyfill does not implement throwIfAborted.
export function assertConnectionRouteActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ConnectionRouteError('Connection cancelled.', false)
  }
}
