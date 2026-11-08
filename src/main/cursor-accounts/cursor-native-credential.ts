import { z } from 'zod'
import { parseCursorSessionToken } from '../rate-limits/cursor-session-token'

/** Everything cursor-agent keeps for one sign-in; switching accounts moves all of it together. */
export type CursorCredentialSnapshot = {
  accessToken: string
  refreshToken: string | null
  apiKey: string | null
  /** `cli-config.json` identity, kept verbatim so a switch restores whatever cursor-agent wrote. */
  authInfo: Record<string, unknown> | null
}

export type CursorNativeCredential = {
  snapshot: CursorCredentialSnapshot
  subject: string
  email: string | null
  displayName: string | null
}

const MAX_SECRET_CHARS = 3000
const SECRET_PATTERN = /^[\w.~+/=-]+$/

const snapshotSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().nullable(),
  apiKey: z.string().nullable(),
  authInfo: z.record(z.string(), z.unknown()).nullable()
})

function invalidCredential(): Error {
  return new Error('Cursor credentials could not be decoded.')
}

/** Secrets travel through `security -i`, so only characters that need no quoting are accepted. */
export function isSafeCursorSecret(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SECRET_CHARS && SECRET_PATTERN.test(value)
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function projectCursorCredential(
  snapshot: CursorCredentialSnapshot
): CursorNativeCredential {
  const token = parseCursorSessionToken(snapshot.accessToken)
  if (!token) {
    throw invalidCredential()
  }
  return {
    snapshot,
    subject: token.subject,
    email: nonEmpty(snapshot.authInfo?.email),
    displayName: nonEmpty(snapshot.authInfo?.displayName)
  }
}

export function serializeCursorSnapshot(snapshot: CursorCredentialSnapshot): string {
  return JSON.stringify(snapshot)
}

export function parseCursorSnapshot(contents: string): CursorNativeCredential {
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch {
    throw invalidCredential()
  }
  const parsed = snapshotSchema.safeParse(value)
  if (!parsed.success) {
    throw invalidCredential()
  }
  return projectCursorCredential(parsed.data)
}
