import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readNativeChatTranscriptTailFile } from './transcript-tail-reader'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

// 128-byte records an agent writes between messages, none of them displayable.
const PROGRESS = `${JSON.stringify({ type: 'progress', data: 'x'.repeat(98) })}\n`

it.each([2, 20])(
  'looks back a bounded number of bytes over a %i× larger tail with no messages',
  async (multiple) => {
    const directory = mkdtempSync(join(tmpdir(), 'transcript-tail-scan-'))
    directories.push(directory)
    const filePath = join(directory, 'session.jsonl')
    const scanBytes = 64 * 1024
    writeFileSync(filePath, PROGRESS.repeat((multiple * scanBytes) / PROGRESS.length))
    let decoded = 0

    const page = await readNativeChatTranscriptTailFile(
      filePath,
      20,
      () => {
        decoded++
        return null
      },
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      scanBytes
    )

    expect(PROGRESS.length).toBe(128)
    // The last 64 KiB of records, however long the file.
    expect(decoded).toBe(512)
    expect(page).toMatchObject({ messages: [], hasMore: true })
  }
)
