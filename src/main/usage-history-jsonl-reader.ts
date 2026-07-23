import { createReadStream } from 'node:fs'

export const MAX_USAGE_HISTORY_JSONL_LINE_BYTES = 4 * 1024 * 1024

export class UsageHistoryJsonlLineCapacityError extends Error {
  constructor(readonly limit = MAX_USAGE_HISTORY_JSONL_LINE_BYTES) {
    super(`Usage history JSONL record exceeded ${limit} bytes`)
    this.name = 'UsageHistoryJsonlLineCapacityError'
  }
}

export async function* readUsageHistoryJsonlLines(
  filePath: string,
  options: { start?: number; maxLineBytes?: number } = {}
): AsyncGenerator<string> {
  const maxLineBytes = options.maxLineBytes ?? MAX_USAGE_HISTORY_JSONL_LINE_BYTES
  const stream = createReadStream(filePath, {
    start: options.start ?? 0,
    highWaterMark: 64 * 1024
  })
  let fragments: Buffer[] = []
  let fragmentBytes = 0

  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    let offset = 0
    while (offset < chunk.length) {
      const newlineIndex = chunk.indexOf(0x0a, offset)
      const end = newlineIndex === -1 ? chunk.length : newlineIndex
      const fragment = chunk.subarray(offset, end)
      if (fragment.length > maxLineBytes - fragmentBytes) {
        throw new UsageHistoryJsonlLineCapacityError(maxLineBytes)
      }
      if (fragment.length > 0) {
        fragments.push(fragment)
        fragmentBytes += fragment.length
      }
      if (newlineIndex === -1) {
        break
      }
      yield decodeJsonlLine(fragments, fragmentBytes)
      fragments = []
      fragmentBytes = 0
      offset = newlineIndex + 1
    }
  }

  if (fragmentBytes > 0) {
    yield decodeJsonlLine(fragments, fragmentBytes)
  }
}

function decodeJsonlLine(fragments: Buffer[], bytes: number): string {
  const line = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, bytes)
  const content = line.at(-1) === 0x0d ? line.subarray(0, -1) : line
  return content.toString('utf8')
}
