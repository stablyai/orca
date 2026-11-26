import { createHash } from 'node:crypto'
import { encodeUsageCacheJson, parseUsageCacheJson } from './usage-cache-json'

const INTEGRITY_HEADER = /^\{"usageIntegrity":"([a-f0-9]{64})",/
const HEADER_CHARS = '{"usageIntegrity":"'.length + 64 + '",'.length

export function protectedUsageCacheJson(
  value: unknown,
  domain: string,
  sealed = true
): {
  bytes: number
  encode: () => Generator<string>
} {
  const hash = createHash('sha256').update(domain).update('\n')
  let bytes = 0
  for (const text of encodeUsageCacheJson(value)) {
    hash.update(text)
    bytes += Buffer.byteLength(text)
  }
  const digest = hash.digest('hex')
  const prefix = `{"usageIntegrity":"${digest}",`
  return {
    bytes: bytes + (sealed ? Buffer.byteLength(prefix) - 1 : 0),
    encode: function* () {
      let first = true
      for (const text of encodeUsageCacheJson(value)) {
        if (first && sealed) {
          if (!text.startsWith('{')) {
            throw new Error('Usage cache integrity requires a JSON object.')
          }
          yield prefix
          yield text.slice(1)
        } else {
          yield text
        }
        first = false
      }
    }
  }
}

/** Verify the original decoded text, never an equivalent re-encoding. */
export async function readProtectedUsageCacheJson<T extends { usageIntegrity?: unknown }>(
  chunks: AsyncIterable<string>,
  domain: string,
  strict = true
): Promise<{ parsed: T; verified: boolean }> {
  const hash = createHash('sha256').update(domain).update('\n{')
  let leading = ''
  let header: RegExpExecArray | null | undefined
  async function* inspect(): AsyncGenerator<string> {
    for await (const text of chunks) {
      if (header === undefined) {
        const taken = Math.min(HEADER_CHARS - leading.length, text.length)
        leading += text.slice(0, taken)
        if (leading.length === HEADER_CHARS) {
          header = INTEGRITY_HEADER.exec(leading)
          if (header) {
            hash.update(text.slice(taken))
          }
        }
      } else if (header) {
        hash.update(text)
      }
      yield text
    }
  }
  const parsed = await parseUsageCacheJson<T>(inspect())
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Saved usage cache must be a JSON object.')
  }
  header ??= INTEGRITY_HEADER.exec(leading)
  if (!header) {
    if (strict && parsed.usageIntegrity !== undefined) {
      throw new Error('Saved usage cache integrity framing is invalid.')
    }
    return { parsed, verified: false }
  }
  const verified = parsed.usageIntegrity === header[1] && hash.digest('hex') === header[1]
  if (strict && !verified) {
    throw new Error('Saved usage cache integrity does not match its contents.')
  }
  return { parsed, verified }
}
