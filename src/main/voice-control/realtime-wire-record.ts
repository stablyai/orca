/**
 * The realtime sideband/CDP boundary guard: narrows an unknown wire value to a plain
 * JSON object. One implementation — the response gate, reply speech, tracing, and tool
 * argument parsing all read the same provider payloads.
 */
export function asWireRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: object/non-null/non-array check above is the full wire contract for a JSON object.
  return value as Record<string, unknown>
}
