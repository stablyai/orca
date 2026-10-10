import { z } from 'zod'

export type CursorDesktopProfile = {
  accessToken: string | null
  email: string | null
  membershipType: string | null
  subscriptionStatus: string | null
}

export type CursorDesktopProfileReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; profile: CursorDesktopProfile }

export function cursorProfileReadFailure(): CursorDesktopProfileReadResult {
  return { status: 'error', error: 'Unable to read the Cursor desktop login' }
}

const nullableString = z.string().nullable()
const resultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('missing') }),
  z.object({ status: z.literal('error'), error: z.string() }),
  z.object({
    status: z.literal('ok'),
    profile: z.object({
      accessToken: nullableString,
      email: nullableString,
      membershipType: nullableString,
      subscriptionStatus: nullableString
    })
  })
])

/** A worker reply arrives as a structured clone; null when it is not a profile read result. */
export function parseCursorProfileReadResult(
  value: unknown
): CursorDesktopProfileReadResult | null {
  const parsed = resultSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
