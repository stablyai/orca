// The wake token a sign-in refresh asks for with this install's id (the invite wake socket's only key).
import type { OrcaCloudWakeToken } from '../cloud-session/profile-cloud-session-exchange'

// The cloud's per-install id format; anything else is refused, so it is never sent.
const MACHINE_ID = /^[A-Za-z0-9_-]{16,64}$/
const MAX_TOKEN_LENGTH = 8 * 1024

/** The refresh body's addition: the install id, when it is one the cloud takes. */
export function wakeTokenRequest(machineId: string | null | undefined): { machineId?: string } {
  return machineId && MACHINE_ID.test(machineId) ? { machineId } : {}
}

/** Read leniently: a missing or malformed wake token is none, and the refresh still counts. */
export function readWakeToken(value: unknown): OrcaCloudWakeToken | undefined {
  if (!value || typeof value !== 'object' || !('token' in value) || !('expiresAt' in value)) {
    return undefined
  }
  const { token, expiresAt } = value
  return typeof token === 'string' &&
    token.length > 0 &&
    token.length <= MAX_TOKEN_LENGTH &&
    typeof expiresAt === 'number' &&
    Number.isFinite(expiresAt)
    ? { token, expiresAt }
    : undefined
}
