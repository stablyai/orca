/** Keys a thread's turn for generic-row bookkeeping; long ids are truncated and hashed. */
export function boundedTurnBucket(threadId: string, turnId: string): string {
  const encoded = `${encodeURIComponent(threadId)}:${encodeURIComponent(turnId)}`
  if (Buffer.byteLength(encoded, 'utf8') <= 512) {
    return encoded
  }
  let hash = 2166136261
  for (const byte of Buffer.from(encoded, 'utf8')) {
    hash ^= byte
    hash = Math.imul(hash, 16777619)
  }
  return `${encoded.slice(0, 160)}:${(hash >>> 0).toString(16)}`
}
