export function sanitizeSonioxError(message: string, apiKey: string): string {
  if (/incorrect api key provided:/i.test(message)) {
    return 'Incorrect API key provided.'
  }
  const withoutConfiguredKey = apiKey ? message.replaceAll(apiKey, '[redacted]') : message
  return withoutConfiguredKey
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .trim()
}
