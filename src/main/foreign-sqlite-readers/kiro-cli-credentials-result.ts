import { z } from 'zod'

/** What Orca needs from kiro-cli's own login; the refresh token never leaves the worker. */
export type KiroCliCredentials = {
  accessToken: string
  /** kiro-cli's ISO expiry, or null when it stored none. */
  expiresAt: string | null
  profileArn: string
}

export type KiroCliCredentialsReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; credentials: KiroCliCredentials }

export function kiroCliCredentialsReadFailure(): KiroCliCredentialsReadResult {
  return { status: 'error', error: 'Unable to read the Kiro CLI login' }
}

const resultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('missing') }),
  z.object({ status: z.literal('error'), error: z.string() }),
  z.object({
    status: z.literal('ok'),
    credentials: z.object({
      accessToken: z.string().min(1),
      expiresAt: z.string().nullable(),
      profileArn: z.string().min(1)
    })
  })
])

/**
 * Validate a structured-clone reply at the worker boundary.
 * @returns The parsed result, or null when the shape is wrong.
 */
export function parseKiroCliCredentialsReadResult(
  value: unknown
): KiroCliCredentialsReadResult | null {
  const parsed = resultSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
