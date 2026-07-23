export type RateLimitPtyOutputAppend = {
  output: string
  scannedChunk: string
}

export function appendRateLimitPtyOutputTail(
  existing: string,
  chunk: string,
  maxChars: number
): RateLimitPtyOutputAppend {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) {
    throw new RangeError('Rate-limit PTY output limit must be a non-negative safe integer')
  }
  if (maxChars === 0) {
    return { output: '', scannedChunk: '' }
  }

  const scannedChunk = chunk.length > maxChars ? copyUtf16Suffix(chunk, maxChars) : chunk
  if (scannedChunk.length >= maxChars) {
    return { output: scannedChunk, scannedChunk }
  }
  const existingBudget = maxChars - scannedChunk.length
  const existingTail = existing.length > existingBudget ? existing.slice(-existingBudget) : existing
  return {
    output: `${existingTail}${scannedChunk}`,
    scannedChunk
  }
}

function copyUtf16Suffix(value: string, maxChars: number): string {
  // Why: a sliced string may retain the oversized PTY chunk's backing store; this bounded round trip detaches it.
  return Buffer.from(value.slice(-maxChars), 'utf16le').toString('utf16le')
}
