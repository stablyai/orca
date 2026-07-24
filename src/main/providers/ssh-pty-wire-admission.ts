import { hasUnsafeProviderSessionIdChars } from '../../shared/agent-session-resume'

export const MAX_SSH_RELAY_PTY_ID_BYTES = 4 * 1024
export const MAX_SSH_APP_PTY_ID_BYTES = 16 * 1024
export const MAX_SSH_PTY_DELIVERY_TOKEN_BYTES = 1024

function admittedStringBytes(value: unknown, maxBytes: number): number | null {
  if (typeof value !== 'string' || value.length === 0 || hasUnsafeProviderSessionIdChars(value)) {
    return null
  }
  const bytes = Buffer.byteLength(value, 'utf8')
  return bytes <= maxBytes ? bytes : null
}

export function admittedSshRelayPtyIdBytes(value: unknown): number | null {
  return admittedStringBytes(value, MAX_SSH_RELAY_PTY_ID_BYTES)
}

export function admittedSshAppPtyIdBytes(value: unknown): number | null {
  return admittedStringBytes(value, MAX_SSH_APP_PTY_ID_BYTES)
}

export function isAdmittedSshRelayPtyId(value: unknown): value is string {
  return admittedSshRelayPtyIdBytes(value) !== null
}

export function isAdmittedSshDeliveryToken(value: unknown): value is string {
  return admittedStringBytes(value, MAX_SSH_PTY_DELIVERY_TOKEN_BYTES) !== null
}
