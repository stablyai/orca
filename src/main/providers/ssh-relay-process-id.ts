export function parseSshRelayProcessId(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new Error('Invalid SSH relay process identity')
  }
  return value
}
