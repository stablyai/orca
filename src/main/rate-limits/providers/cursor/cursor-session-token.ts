import { z } from 'zod'

const jwtPayloadSchema = z.object({ sub: z.unknown(), exp: z.unknown() }).partial()

export type CursorSessionToken = {
  raw: string
  /** WorkOS subject (`auth0|user_…`), the first half of the dashboard session cookie. */
  subject: string
  expiresAtMs: number | null
}

function decodeJwtPayload(token: string): z.infer<typeof jwtPayloadSchema> | null {
  const parts = token.split('.')
  if (parts.length < 2 || !parts[1]) {
    return null
  }
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const parsed = jwtPayloadSchema.safeParse(
      JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    )
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function parseCursorSessionToken(raw: string): CursorSessionToken | null {
  const trimmed = raw.trim()
  if (!trimmed) {
    return null
  }
  const payload = decodeJwtPayload(trimmed)
  const subject = payload?.sub
  if (typeof subject !== 'string' || subject.trim().length === 0) {
    return null
  }
  const exp = payload?.exp
  return {
    raw: trimmed,
    subject: subject.trim(),
    expiresAtMs: typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null
  }
}

export function isCursorSessionTokenExpired(
  token: CursorSessionToken,
  nowMs: number = Date.now()
): boolean {
  return token.expiresAtMs !== null && token.expiresAtMs <= nowMs
}

/** Cookie the cursor.com dashboard sends: `<subject>::<jwt>`, URL-escaped. */
export function cursorSessionCookie(token: CursorSessionToken): string {
  return `WorkosCursorSessionToken=${encodeURIComponent(token.subject)}%3A%3A${token.raw}`
}
