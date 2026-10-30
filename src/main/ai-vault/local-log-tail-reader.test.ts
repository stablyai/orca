import { mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { LOCAL_LOG_TAIL_CHUNK_BYTES } from '../../shared/local-log-tail-types'
import { readLocalLogTailRange } from './local-log-tail-reader'

const tempPaths: string[] = []

async function makeLog(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-local-log-tail-'))
  tempPaths.push(directory)
  const filePath = join(directory, 'session.jsonl')
  await writeFile(filePath, content)
  return filePath
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('readLocalLogTailRange', () => {
  it('reads only the requested appended range', async () => {
    const filePath = await makeLog('first\nsecond\n')
    const result = await readLocalLogTailRange(filePath, Buffer.byteLength('first\n'))

    expect(Buffer.from(result.contentBase64, 'base64').toString('utf8')).toBe('second\n')
    expect(result.nextByteOffset).toBe(Buffer.byteLength('first\nsecond\n'))
    expect(result.hasMore).toBe(false)
    expect(result.reset).toBe(false)
  })

  it('caps each response and reports that more bytes remain', async () => {
    const filePath = await makeLog('x'.repeat(LOCAL_LOG_TAIL_CHUNK_BYTES + 17))
    const result = await readLocalLogTailRange(filePath, 0)

    expect(Buffer.from(result.contentBase64, 'base64')).toHaveLength(LOCAL_LOG_TAIL_CHUNK_BYTES)
    expect(result.nextByteOffset).toBe(LOCAL_LOG_TAIL_CHUNK_BYTES)
    expect(result.hasMore).toBe(true)
  })

  it('requests a reset after truncation', async () => {
    const filePath = await makeLog('first\nsecond\n')
    const initial = await readLocalLogTailRange(filePath, 0)
    await truncate(filePath, 2)

    const result = await readLocalLogTailRange(
      filePath,
      initial.nextByteOffset,
      initial.fileIdentity
    )
    expect(result.reset).toBe(true)
    expect(result.nextByteOffset).toBe(0)
    expect(result.fileSize).toBe(2)
  })

  it('requests a reset when the file is atomically replaced', async () => {
    const filePath = await makeLog('old\n')
    const initial = await readLocalLogTailRange(filePath, 0)
    const replacement = `${filePath}.next`
    await writeFile(replacement, 'new and longer\n')
    await rename(replacement, filePath)

    const result = await readLocalLogTailRange(
      filePath,
      initial.nextByteOffset,
      initial.fileIdentity
    )
    expect(result.reset).toBe(true)
    expect(result.fileIdentity).not.toBe(initial.fileIdentity)
  })
})
