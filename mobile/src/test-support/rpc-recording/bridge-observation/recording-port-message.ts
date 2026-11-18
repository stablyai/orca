export function wire(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Port observation requires an actual message object')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: JSON object checked above.
  return value as Record<string, unknown>
}
