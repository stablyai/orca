import { CLAUDE_IMPORT_PAGE_DATA_BYTES } from './journal-claude-import-worker-protocol'

/** Newlines separate serialized items. The writer can join fragments of even one wide item. */
export function* claudeImportPages(items: readonly Buffer[]): IterableIterator<Uint8Array> {
  let page = Buffer.allocUnsafeSlow(CLAUDE_IMPORT_PAGE_DATA_BYTES)
  let used = 0
  for (const item of items) {
    let offset = 0
    while (offset < item.length) {
      const count = item.copy(page, used, offset)
      used += count
      offset += count
      if (used === page.length) {
        yield page
        page = Buffer.allocUnsafeSlow(CLAUDE_IMPORT_PAGE_DATA_BYTES)
        used = 0
      }
    }
    page[used++] = 10
    if (used === page.length) {
      yield page
      page = Buffer.allocUnsafeSlow(CLAUDE_IMPORT_PAGE_DATA_BYTES)
      used = 0
    }
  }
  if (used) {
    yield page.subarray(0, used)
  }
}
