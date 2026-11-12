export function boundedText(value: string, limit = 2_048): string {
  const tail =
    value.length > limit
      ? value.slice(-limit).replace(/^[^\r\n]*(?:\r?\n|$)/u, '[truncated]\n')
      : value
  return tail
    .replace(/\b(?:https?|wss?):\/\/\S+/giu, '[url]')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/((?:token|pairingCode|authToken)["'=:\s]+)\S+/giu, '$1[redacted]')
    .slice(-limit)
}
