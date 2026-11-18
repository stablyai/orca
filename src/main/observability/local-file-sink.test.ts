import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLocalFileSink } from './local-file-sink'

describe.skipIf(process.platform === 'win32')('trace-file privacy', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-sink-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates trace directories and files with private POSIX permissions', () => {
    const file = join(dir, 'logs', 'test.ndjson')
    const sink = createLocalFileSink({
      filePath: file,
      batchWindowMs: 100_000
    })
    sink.push({ ok: true })
    sink.close()

    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('tightens permissions on an existing rotated trace family', () => {
    const file = join(dir, 'test.ndjson')
    const rotated = `${file}.1`
    writeFileSync(file, '{}\n')
    writeFileSync(rotated, '{}\n')
    chmodSync(file, 0o644)
    chmodSync(rotated, 0o644)

    const sink = createLocalFileSink({
      filePath: file,
      maxFiles: 3,
      batchWindowMs: 100_000
    })
    sink.close()

    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(rotated).mode & 0o777).toBe(0o600)
  })
})
