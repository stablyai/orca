import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProviderRelayLineReader } from '../provider-relay-line-reader'

describe('provider relay line reader', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-lines-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('stitches a line spilled to disk back whole, in order with the lines around it', async () => {
    const spillPath = join(dir, 'r.ndjson.line')
    const lines: string[] = []
    const reader = new ProviderRelayLineReader({
      spillPath,
      onLine: (line) => lines.push(line),
      onBusy: () => {},
      spillBytes: 1024
    })
    const long = 'é漢x'.repeat(5_000)
    const bytes = Buffer.from(`first\n${long}\nlast-no-newline`)
    for (let at = 0; at < bytes.length; at += 777) {
      reader.push(bytes.subarray(at, at + 777))
    }
    await reader.end()
    expect(lines).toEqual(['first', long, 'last-no-newline'])
    expect(existsSync(spillPath)).toBe(false)
  })

  it('delivers a line whole from memory when the spill file cannot be created', async () => {
    const lines: string[] = []
    const reader = new ProviderRelayLineReader({
      spillPath: join(dir, 'missing-folder', 'r.ndjson.line'),
      onLine: (line) => lines.push(line),
      onBusy: () => {},
      spillBytes: 8
    })
    reader.push(Buffer.from('abcdefghijkl'))
    reader.push(Buffer.from('mn\n'))
    await reader.end()
    expect(lines).toEqual(['abcdefghijklmn'])
  })
})
