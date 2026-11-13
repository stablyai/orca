import { appendFileSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { WorkerTranscriptReadResult } from './worker-transcript-read'
import {
  readInitialWorkerTranscriptReusing,
  settledTranscriptPages
} from './worker-transcript-initial-read-cache'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function transcript(text = 'first'): string {
  const directory = mkdtempSync(join(tmpdir(), 'transcript-initial-read-'))
  directories.push(directory)
  const filePath = join(directory, 'session.jsonl')
  writeFileSync(filePath, `${text}\n`)
  return filePath
}

/** A scan that answers with the file's current text, counting how often it runs. */
function scanner(payloadBytes = 16) {
  const scan = Object.assign(
    async (filePath: string): Promise<WorkerTranscriptReadResult> => {
      scan.calls++
      await new Promise((resolve) => setImmediate(resolve))
      return {
        ok: true,
        filePath,
        sourceFingerprint: 'f',
        boundaryCheckpoint: 'c',
        messages: [
          {
            id: 'm',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'x'.repeat(payloadBytes) }],
            timestamp: null,
            source: 'transcript'
          }
        ],
        nextOffset: statSync(filePath).size,
        limited: false,
        clipping: [],
        warnings: []
      }
    },
    { calls: 0 }
  )
  return scan
}

const decoder = () => null
const read = (filePath: string, scan: ReturnType<typeof scanner>) =>
  readInitialWorkerTranscriptReusing(filePath, [20, decoder], () => scan(filePath))

it.each([12, 120])(
  'shares one scan per unchanged file among %i files read at once, past the settled limit',
  async (files) => {
    const scan = scanner()
    const paths = Array.from({ length: files }, () => transcript())
    const firstAgain = read(paths[0]!, scan)
    await Promise.all([...paths.map((path) => read(path, scan)), firstAgain])
    expect(scan.calls).toBe(files)
    expect(settledTranscriptPages().entries).toBeLessThanOrEqual(16)

    await read(paths.at(-1)!, scan)
    expect(scan.calls).toBe(files)
  }
)

it('keeps only the current version, within its byte budget', async () => {
  const filePath = transcript()
  const scan = scanner(64 * 1024)
  for (let version = 0; version < 20; version++) {
    appendFileSync(filePath, `append ${version}\n`)
    await read(filePath, scan)
  }
  expect(settledTranscriptPages(filePath).entries).toBe(1)

  // A page past the per-entry budget is served whole and never kept.
  const big = scanner(600 * 1024)
  const result = await read(transcript(), big)
  expect(result.ok && result.messages[0]?.blocks).toHaveLength(1)
  expect(settledTranscriptPages().bytes).toBeLessThan(8 * 1024 * 1024)
})

it('rereads a same-size rewrite whose modification time was put back', async () => {
  const filePath = transcript('first')
  const scan = scanner()
  await read(filePath, scan)
  const { atime, mtime } = statSync(filePath)
  writeFileSync(filePath, 'after\n')
  utimesSync(filePath, atime, mtime)

  await read(filePath, scan)

  expect(scan.calls).toBe(2)
})

it('never settles a scan the file changed under, a failure, or another variant', async () => {
  const filePath = transcript()
  const scan = scanner()
  await readInitialWorkerTranscriptReusing(filePath, [20, decoder], async () => {
    const result = await scan(filePath)
    appendFileSync(filePath, 'written during the scan\n')
    return result
  })
  await read(filePath, scan)
  expect(scan.calls).toBe(2)

  const otherDecoder = () => null
  await expect(
    readInitialWorkerTranscriptReusing(filePath, [20, otherDecoder], async () => {
      throw new Error('old decoder failed')
    })
  ).rejects.toThrow('old decoder failed')
  await read(filePath, scan)
  expect(scan.calls).toBe(2)
})
