import {
  projectionError,
  reclaimProjectionRecord,
  type DesktopProjectionSpan,
  type ProjectionRecord
} from './ssh-pty-legacy-projection-record'

export function publishLegacyProjectionPrefix(
  records: Map<string, ProjectionRecord>,
  ids: readonly string[],
  displayChars: number,
  accountingChars: number
): void {
  let displayRemaining = Math.max(0, displayChars)
  let accountingRemaining = Math.max(0, accountingChars)
  for (const id of ids) {
    const record = records.get(id)
    if (!record) {
      continue
    }
    const displayLength =
      record.semantics.identity.displayEnd - record.semantics.identity.displayStart
    const unpublishedDisplay = displayLength - record.publishedDisplay
    const unpublishedAccounting = record.semantics.identity.rawLength - record.publishedAccounting
    if (displayLength === 0 && unpublishedAccounting > 0) {
      const publishAccounting = Math.min(accountingRemaining, unpublishedAccounting)
      if (publishAccounting !== unpublishedAccounting) {
        throw projectionError('ssh_projection_indivisible_split')
      }
      record.publishedAccounting += publishAccounting
      record.state = 'published'
      accountingRemaining -= publishAccounting
      continue
    }
    if (unpublishedDisplay <= 0) {
      continue
    }
    const publishDisplay = Math.min(displayRemaining, unpublishedDisplay)
    if (publishDisplay <= 0) {
      break
    }
    if (record.semantics.identity.transformed && publishDisplay !== unpublishedDisplay) {
      throw projectionError('ssh_projection_indivisible_split')
    }
    const publishAccounting =
      publishDisplay === unpublishedDisplay
        ? Math.min(accountingRemaining, unpublishedAccounting)
        : publishDisplay
    record.publishedDisplay += publishDisplay
    record.publishedAccounting += publishAccounting
    record.state = 'published'
    displayRemaining -= publishDisplay
    accountingRemaining -= publishAccounting
  }
  if (displayRemaining !== 0 || accountingRemaining !== 0) {
    throw projectionError('ssh_projection_publish_range_mismatch')
  }
}

export function hasUnpublishedLegacyProjection(
  records: ReadonlyMap<string, ProjectionRecord>,
  id: string
): boolean {
  const record = records.get(id)
  if (!record || record.state === 'reserved') {
    return false
  }
  const displayLength =
    record.semantics.identity.displayEnd - record.semantics.identity.displayStart
  return (
    record.publishedDisplay < displayLength ||
    record.publishedAccounting < record.semantics.identity.rawLength
  )
}

export function settlePublishedLegacyProjectionPrefix(
  records: Map<string, ProjectionRecord>,
  idsByPty: Map<string, string[]>,
  ptyId: string,
  accountingChars: number,
  onSettled: ((span: DesktopProjectionSpan, reason: string) => void) | undefined
): { settled: number; completed: number } {
  let remaining = Math.max(0, accountingChars)
  let settled = 0
  let completed = 0
  for (const id of idsByPty.get(ptyId)?.slice() ?? []) {
    const record = records.get(id)
    if (!record) {
      continue
    }
    const available = record.publishedAccounting - record.settledAccounting
    if (available <= 0) {
      continue
    }
    const take = Math.min(remaining, available)
    const finishes =
      record.settledAccounting + take === record.semantics.identity.rawLength &&
      record.publishedDisplay ===
        record.semantics.identity.displayEnd - record.semantics.identity.displayStart
    if (finishes && record.semantics.desktopSpan) {
      onSettled?.(record.semantics.desktopSpan, 'renderer-parse')
    }
    record.settledAccounting += take
    settled += take
    remaining -= take
    if (finishes) {
      completed++
      reclaimProjectionRecord(records, idsByPty, id, ptyId)
    }
    if (remaining === 0) {
      break
    }
  }
  return { settled, completed }
}
