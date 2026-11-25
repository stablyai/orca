import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { LOCAL_PATH_SCAN_MAX, localPathWarning } from './peer-mail-local-paths'

describe('local paths in mail to another computer', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-local-paths-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('names a file cited with a line number', async () => {
    const file = join(dir, 'send-queue.ts')
    writeFileSync(file, '')
    expect(
      (await localPathWarning(`See ${file}:42:7 for it.`, 'bot:Docs', 'm4'))?.message
    ).toContain(`names ${file} on this computer`)
  })

  it('names a file at the end of a CRLF line', async () => {
    const file = join(dir, 'brief.md')
    writeFileSync(file, '')
    expect((await localPathWarning(`See ${file}\r\nNext.`, 'bot:Docs', 'm4'))?.message).toContain(
      `names ${file} on this computer`
    )
  })

  it('names no bare home or temp folder', async () => {
    expect(
      await localPathWarning(`Scratch lives in ${tmpdir()} and ~/ here.`, 'bot:Docs', 'm4')
    ).toBeNull()
  })

  it('still finds a file after a long run of other slashes', async () => {
    const file = join(dir, 'brief.md')
    writeFileSync(file, '')
    const noise = ' a / b </div>'.repeat(5000)
    expect(await localPathWarning(`${noise} ${file}`, 'bot:Docs', 'm4')).toBeNull()
    expect(await localPathWarning(`${file} ${noise}`, 'bot:Docs', 'm4')).not.toBeNull()
  })

  it('searches only the start of a long body, however long its tail grows', async () => {
    const file = join(dir, 'brief.md')
    writeFileSync(file, '')
    const filler = 'x'.repeat(LOCAL_PATH_SCAN_MAX)
    expect(await localPathWarning(`${file} ${filler}`, 'bot:Docs', 'm4')).not.toBeNull()
    // Every stat the scan asks for is a path it read; one past the region is never read.
    const read: string[] = []
    const statPath = async (path: string) => {
      read.push(path)
    }
    for (const tail of [1, 10, 100]) {
      read.length = 0
      const body = `${filler} ${file}${' /tmp/x'.repeat(tail * 1000)}`
      expect(await localPathWarning(body, 'bot:Docs', 'm4', statPath)).toBeNull()
      expect(read).toEqual([])
    }
  })

  it('sends without the warning when the disk stalls, leaving a bounded set of lookups', async () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const held: (() => void)[] = []
    const statPath = () => new Promise<void>((done) => held.push(done))
    const body = Array.from({ length: 30 }, (_, n) => `${join(dir, `f${n}.md`)} a b c d`).join('\n')

    const warning = localPathWarning(body, 'bot:Docs', 'm4', statPath)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await warning).toBeNull()
    // At most 10 path starts, each read at most 5 ways.
    expect(held.length).toBeLessThanOrEqual(50)
    expect(held.length).toBeGreaterThan(0)
    held.forEach((release) => release())
  })

  it('names several files as a list, and counts the rest', async () => {
    const files = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'].map((name) => join(dir, name))
    files.forEach((file) => writeFileSync(file, ''))
    const named = async (count: number) =>
      (await localPathWarning(files.slice(0, count).join('\n'), 'bot:Docs', 'm4'))?.message
    const [a, b, c] = files
    expect(await named(2)).toContain(`names ${a} and ${b} on this computer`)
    expect(await named(3)).toContain(`names ${a}, ${b}, and ${c} on this computer`)
    expect(await named(5)).toContain(`names ${a}, ${b}, ${c}, and 2 more on this computer`)
    expect(await named(1)).toContain('or attach it to a bot item with --file.')
  })
})
