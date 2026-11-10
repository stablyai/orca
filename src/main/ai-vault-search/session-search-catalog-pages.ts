const PAGE_ROWS = 256
const PAGE_BYTES = 256 * 1024

/** Stop before decoding another page; one oversized valid record remains an accounted transient. */
export function boundedSessionSearchPage<T, R>(rows: Iterable<R>, decode: (row: R) => T): T[] {
  const page: T[] = []
  let bytes = 0
  for (const row of rows) {
    const value = decode(row)
    const size = JSON.stringify(value).length * 2 + 64
    if (page.length && (page.length === PAGE_ROWS || bytes + size > PAGE_BYTES)) {
      break
    }
    page.push(value)
    bytes += size
  }
  return page
}
