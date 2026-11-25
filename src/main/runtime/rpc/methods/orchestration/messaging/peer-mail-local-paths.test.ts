import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { LOCAL_PATH_LINE_MAX, LOCAL_PATH_SCAN_MAX, localPathWarning } from './peer-mail-local-paths'

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

  it('keeps the spaces a folder name holds', async () => {
    mkdirSync(join(dir, 'My  Project'))
    const file = join(dir, 'My  Project', 'brief.md')
    writeFileSync(file, '')
    expect((await localPathWarning(`See ${file} now.`, 'bot:Docs', 'm4'))?.message).toContain(
      `names ${file} on this computer`
    )
  })

  it('reads a quoted path as its whole quoted text', async () => {
    const report = join(dir, 'report')
    writeFileSync(report, '')
    // Only the shorter path exists: the quoted one names a different file.
    expect(
      await localPathWarning(`See "${join(dir, 'report notes.md')}".`, 'bot:Docs', 'm4')
    ).toBeNull()
    expect((await localPathWarning(`See "${report}".`, 'bot:Docs', 'm4'))?.message).toContain(
      `names ${report} on this computer`
    )
    mkdirSync(join(dir, 'My Project'))
    const spaced = join(dir, 'My Project', 'brief.md')
    writeFileSync(spaced, '')
    expect(
      (await localPathWarning(`Read \`${spaced}\` first.`, 'bot:Docs', 'm4'))?.message
    ).toContain(`names ${spaced} on this computer`)
  })

  describe('a path that a cap cuts', () => {
    /** The disk has only `exists`; every other path is missing. */
    const onlyFile =
      (...exists: string[]) =>
      async (path: string) => {
        if (!exists.includes(path)) {
          throw new Error('ENOENT')
        }
      }
    const warned = async (body: string, ...exists: string[]) =>
      (await localPathWarning(body, 'bot:Docs', 'm4', onlyFile(...exists)))?.message ?? null
    /** A multi-folder path under this host's temp folder, in its own separators, exactly as long as
     *  the line cap. Its lookups are stubbed, so it needn't exist (or fit the OS's path limit). */
    const capLongPath = () => {
      let path = dir
      while (LOCAL_PATH_LINE_MAX - path.length > 16) {
        path += `${sep}a`
      }
      return `${path}${sep}${'b'.repeat(LOCAL_PATH_LINE_MAX - path.length - 1)}`
    }

    it('at the end of the scanned region, is read to where the body ends it', async () => {
      // This host's own paths under the temp folder, so the scan admits them on any OS.
      const path = join(dir, 'orca-c2-report')
      const earlier = join(dir, 'orca-c2-earlier')
      // The path ends exactly at the region's end.
      const lead = `${'x'.repeat(LOCAL_PATH_SCAN_MAX - path.length - 1)} `
      expect(await warned(`${lead}${path}-archive`, path)).toBeNull()
      expect(await warned(`${lead}${path}`, path)).toContain(`names ${path} on`)
      expect(await warned(`${lead}${path} and more`, path)).toContain(`names ${path} on`)
      expect(await warned(`${lead}${path}\nnext`, path)).toContain(`names ${path} on`)
      // A complete path before it still counts.
      const both = `${earlier} ${lead.slice(earlier.length + 1)}${path}-archive`
      expect(both.indexOf(`${path}-archive`)).toBe(lead.length)
      expect(await warned(both, earlier)).toContain(`names ${earlier} on`)
    })

    it('at the line cap, is never read as the shorter path the cap leaves', async () => {
      const path = capLongPath()
      expect(path).toHaveLength(LOCAL_PATH_LINE_MAX)
      expect(await warned(`${path}-archive`, path)).toBeNull()
      expect(await warned(path, path)).toContain(`names ${path} on`)
      for (const after of [' x', '\tx', '\nnext', '\r\nnext']) {
        expect(await warned(`${path}${after}`, path)).toContain(`names ${path} on`)
      }
    })

    it('reads a quote still open at the line cap as naming nothing', async () => {
      const path = capLongPath()
      // The quoted name runs on past the cap: a space or tab there ends no quote.
      for (const gap of [' ', '\t']) {
        expect(await warned(`"${path}${gap}extended.md".`, path)).toBeNull()
      }
      // Nor does a bare CR, which ends no line.
      expect(await warned(`"${path}\rextended.md".`, path)).toBeNull()
      // Unquoted, the same space or tab does end the word.
      expect(await warned(`${path} extended.md`, path)).toContain(`names ${path} on`)
      expect(await warned(`${path}\r\nnext`, path)).toContain(`names ${path} on`)
      // A quote never closed before the line truly ends is no quoting.
      const short = join(dir, 'report')
      expect(await warned(`See "${short}`, short)).toContain(`names ${short} on`)
      expect(await warned(`See "${short}\nnext"`, short)).toContain(`names ${short} on`)
      expect(await warned(`See "${short}".`, short)).toContain(`names ${short} on`)
    })
  })

  describe('a complete quoted path', () => {
    const onlyFile =
      (...exists: string[]) =>
      async (path: string) => {
        if (!exists.includes(path)) {
          throw new Error('ENOENT')
        }
      }
    const warned = async (body: string, ...exists: string[]) =>
      (await localPathWarning(body, 'bot:Docs', 'm4', onlyFile(...exists)))?.message ?? null

    it('owns its text: no path inside it is read on its own', async () => {
      const inner = join(dir, 'report')
      const quoted = `${join(dir, 'missing')} ${inner} notes.md`
      const after = join(dir, 'after.md')
      expect(await warned(`See "${quoted}".`, inner)).toBeNull()
      expect(await warned(`See "${quoted}".`, quoted)).toContain(`names ${quoted} on`)
      // Paths after the closing quote are still read, quoted or not.
      expect(await warned(`See "${quoted}" and ${after}.`, inner, after)).toContain(
        `names ${after} on`
      )
      expect(await warned(`See "${quoted}" and '${after}'.`, inner, after)).toContain(
        `names ${after} on`
      )
    })
  })
})
