import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeTccDenialDiagnostics } from '../tcc-denial-diagnostics-file'

let dir: string | null = null

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true })
    dir = null
  }
})

describe('writeTccDenialDiagnostics', () => {
  it('keeps the newest 10 captures', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tcc-denial-diag-'))
    const file = join(dir, 'logs', 'terminal-folder-denials.ndjson')
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => writeTccDenialDiagnostics({ index }, file))
    )
    const indexes = (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).index)
    expect(indexes).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  it('drops the oldest captures to stay under 256 KB', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tcc-denial-diag-'))
    const file = join(dir, 'terminal-folder-denials.ndjson')
    for (let index = 0; index < 4; index++) {
      await writeTccDenialDiagnostics({ index, lines: 'x'.repeat(100_000) }, file)
    }
    const content = await readFile(file, 'utf8')
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(256 * 1024)
    expect(
      content
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).index)
    ).toEqual([2, 3])
  })

  it('keeps earlier captures when one new capture alone is over the cap', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tcc-denial-diag-'))
    const file = join(dir, 'terminal-folder-denials.ndjson')
    await writeTccDenialDiagnostics({ index: 0 }, file)
    await writeTccDenialDiagnostics({ index: 1, lines: 'x'.repeat(300_000) }, file)
    expect(JSON.parse((await readFile(file, 'utf8')).trim()).index).toBe(0)
  })
})
