import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  clearNativeChatTranscriptCache,
  readNativeChatTranscriptCached
} from './transcript-read-cache'

const describePerf = process.env.ORCA_NATIVE_CHAT_PERF_BENCH === '1' ? describe : describe.skip
const TARGET_BYTES = Number(process.env.ORCA_NATIVE_CHAT_PERF_BYTES ?? 16 * 1024 * 1024)
const CONCURRENCY = Number(process.env.ORCA_NATIVE_CHAT_PERF_CONCURRENCY ?? 8)
const ROUNDS = 5

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

describePerf('native chat transcript cache concurrent-miss cost', () => {
  let root = ''
  let filePath = ''
  let fileBytes = 0

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-native-chat-cache-inflight-'))
    filePath = join(root, 'transcript.jsonl')
    const line = `${JSON.stringify({ type: 'progress', data: 'x'.repeat(72) })}\n`
    await writeFile(filePath, line.repeat(Math.ceil(TARGET_BYTES / Buffer.byteLength(line))))
    fileBytes = (await stat(filePath)).size
  })

  afterAll(async () => {
    clearNativeChatTranscriptCache()
    await rm(root, { recursive: true, force: true })
  })

  it('measures simultaneous reads of one uncached production transcript', async () => {
    const durations: number[] = []
    for (let round = 0; round < ROUNDS; round++) {
      clearNativeChatTranscriptCache()
      const startedAt = performance.now()
      const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, () =>
          readNativeChatTranscriptCached('claude', 'bench', filePath)
        )
      )
      durations.push(performance.now() - startedAt)
      expect(results.every((result) => 'messages' in result)).toBe(true)
    }
    console.log(
      `concurrent cache misses median: ${median(durations).toFixed(2)} ms ` +
        `(${CONCURRENCY} callers, ${fileBytes} bytes)`
    )
  })
})
