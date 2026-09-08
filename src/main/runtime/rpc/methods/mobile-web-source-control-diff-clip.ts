export const MOBILE_WEB_SOURCE_CONTROL_MAX_RESULT_BYTES = 512 * 1024

/** Escaped line text can exceed the byte budget even within the row-count limit the page asked
 * for, so the last rows are dropped until the page fits and the page resumes from `nextOffset`. */
export function clipMobileWebDiffResult<T extends object>(page: T): T {
  const rows = 'rows' in page ? (page as { rows: unknown }).rows : undefined
  if (!Array.isArray(rows) || typeof (page as { offset?: unknown }).offset !== 'number') {
    return page
  }
  const clipped = page as T & { offset: number; rows: unknown[]; nextOffset: number | null }
  while (
    Buffer.byteLength(JSON.stringify(clipped)) > MOBILE_WEB_SOURCE_CONTROL_MAX_RESULT_BYTES &&
    clipped.rows.length > 1
  ) {
    clipped.rows.pop()
    clipped.nextOffset = clipped.offset + clipped.rows.length
  }
  return clipped
}
