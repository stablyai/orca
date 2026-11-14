/** Preserve the existing ISO/local and SQLite/UTC completion timestamp contract. */
export function dispatchCompletionEpoch(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null
  }
  const epoch = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isFinite(epoch) ? epoch : null
}
