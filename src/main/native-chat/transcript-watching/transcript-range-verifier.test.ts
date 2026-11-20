import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readNativeChatTranscriptTailFile } from '../transcript-tail-reader'
import { verifyTranscriptRanges } from './transcript-range-verifier'

it('matches untouched bytes and rejects a same-length rewrite or swapped lines', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-chat-range-'))
  const file = join(directory, 'session.jsonl')
  try {
    await writeFile(file, '{"text":"old"}\n{"text":"end"}\n')
    const snapshot = await readNativeChatTranscriptTailFile(file, 10, (line, id) => ({
      id,
      role: 'user',
      blocks: [{ type: 'text', text: line }],
      timestamp: 1,
      source: 'transcript'
    }))
    const ranges = snapshot.ranges
    if (!ranges) {
      throw new Error('Missing transcript byte ranges')
    }
    expect(await verifyTranscriptRanges(file, ranges)).toEqual([true])
    await writeFile(file, '{"text":"new"}\n{"text":"end"}\n')
    expect(await verifyTranscriptRanges(file, ranges)).toEqual([false])
    await writeFile(file, '{"text":"end"}\n{"text":"old"}\n')
    expect(await verifyTranscriptRanges(file, ranges)).toEqual([false])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
