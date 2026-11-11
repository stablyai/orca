const PAGE_ROWS = 256
const PAGE_BYTES = 256 * 1024

/** Stop before decoding another page; one oversized valid record remains an accounted transient. */
export function boundedSessionSearchPage<T, R>(
  rows: Iterable<R>,
  decode: (row: R) => T,
  options: { accept?: (value: T) => void; overheadBytes?: number } = {}
): T[] {
  const page: T[] = []
  let bytes = options.overheadBytes ?? 1024
  for (const row of rows) {
    const value = decode(row)
    const size = JSON.stringify(value).length * 2 + 64
    if (page.length && (page.length === PAGE_ROWS || bytes + size > PAGE_BYTES)) {
      break
    }
    page.push(value)
    options.accept?.(value)
    bytes += size
  }
  return page
}

export function* sessionSearchRecordPages<T>(records: Iterable<T>): Generator<T[]> {
  let page: T[] = []
  let bytes = 1024
  for (const record of records) {
    const size = JSON.stringify(record).length * 2 + 64
    if (page.length && (page.length === PAGE_ROWS || bytes + size > PAGE_BYTES)) {
      yield page
      page = []
      bytes = 1024
    }
    page.push(record)
    bytes += size
  }
  if (page.length) {
    yield page
  }
}
