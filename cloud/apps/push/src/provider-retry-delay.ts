export function providerRetryAfter(
  value: string | undefined,
  now = Date.now()
): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined
}
