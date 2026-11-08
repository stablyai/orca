import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  writeFileDurable
} from './durable-file-write'

describe('durable file write', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-durable-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('durably writes a binary view without leaking bytes outside its bounds', async () => {
    const final = join(dir, 'state.gz')
    const backing = Buffer.from([99, 0x1f, 0x8b, 0, 0xff, 77])
    await writeFileDurable(`${final}.tmp`, final, backing.subarray(1, -1))
    expect(readFileSync(final)).toEqual(Buffer.from([0x1f, 0x8b, 0, 0xff]))
    expect(existsSync(`${final}.tmp`)).toBe(false)
  })

  it('reclaims only the retired owner in this process', async () => {
    const final = join(dir, 'state.json')
    const retired = durableWriteTempPath(final, 'worker-1')
    const replacement = durableWriteTempPath(final, 'worker-2')
    const unowned = durableWriteTempPath(final)
    const otherProcess = `${final}.${process.pid + 1}.1.test.owner-worker-1.tmp`
    const otherTarget = durableWriteTempPath(join(dir, 'other-state.json'), 'worker-1')
    const temps = [retired, replacement, unowned, otherProcess, otherTarget]
    for (const temp of temps) {
      writeFileSync(temp, 'pending')
    }
    writeFileSync(final, 'committed')

    await removeStaleDurableWriteTempFiles(final, { retiredOwner: 'worker-1' })

    expect(existsSync(retired)).toBe(false)
    for (const live of [replacement, unowned, otherProcess, otherTarget]) {
      expect(existsSync(live)).toBe(true)
    }
    expect(readFileSync(final, 'utf-8')).toBe('committed')
  })
})
