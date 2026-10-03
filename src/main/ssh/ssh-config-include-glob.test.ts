import { globSync, mkdirSync, mkdtempSync, opendirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { globIncludePattern, MAX_INCLUDE_GLOB_ENTRIES } from './ssh-config-include-glob'

const cleanupDirs: string[] = []

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-ssh-include-glob-'))
  cleanupDirs.push(dir)
  return dir
}

describe('globIncludePattern', () => {
  it('bounds discovery of a very wide directory instead of enumerating it whole', () => {
    const root = makeTempTree()
    const wideDir = join(root, 'wide')
    mkdirSync(wideDir)
    // Direct writes (hard links cap out around 1023 per file on NTFS).
    const totalEntries = MAX_INCLUDE_GLOB_ENTRIES + 400
    const confStride = 500
    for (let index = 0; index < totalEntries; index += 1) {
      writeFileSync(join(wideDir, `entry-${String(index).padStart(5, '0')}.txt`), 'x')
      if (index % confStride === 0) {
        writeFileSync(join(wideDir, `cfg-${String(index).padStart(5, '0')}.conf`), 'Host x')
      }
    }

    const { matches, truncated, truncatedAt } = globIncludePattern(
      `${wideDir.replace(/\\/g, '/')}/*.conf`
    )

    expect(truncated).toBe(true)
    expect(truncatedAt).toBe(wideDir.replace(/\\/g, '/'))
    expect(matches.length).toBeGreaterThan(0)
    expect(matches.length).toBeLessThan(totalEntries / confStride + 1)
    for (const match of matches) {
      expect(match.endsWith('.conf')).toBe(true)
    }
  })

  it('keeps file matches for a trailing recursive glob', () => {
    const root = makeTempTree()
    const confDir = join(root, 'conf.d')
    mkdirSync(confDir)
    writeFileSync(join(confDir, 'main.conf'), 'Host main')
    writeFileSync(join(confDir, 'extra.conf'), 'Host extra')

    const { matches } = globIncludePattern(`${root.replace(/\\/g, '/')}/conf.d/**`)

    expect(matches.some((entry) => entry.endsWith('main.conf'))).toBe(true)
    expect(matches.some((entry) => entry.endsWith('extra.conf'))).toBe(true)
  })

  it('expands brace alternatives in the last segment', () => {
    const root = makeTempTree()
    // makeTempTree already created the directory.
    writeFileSync(join(root, 'main.conf'), 'Host main')
    writeFileSync(join(root, 'extra.conf'), 'Host extra')

    const { matches } = globIncludePattern(`${root.replace(/\\/g, '/')}/{main,extra}.conf`)

    expect(matches.some((entry) => entry.endsWith('main.conf'))).toBe(true)
    expect(matches.some((entry) => entry.endsWith('extra.conf'))).toBe(true)
  })

  it('does not let the entry budget hide brace matches', () => {
    const root = makeTempTree()
    const subDir = join(root, 'sub')
    mkdirSync(subDir)
    writeFileSync(join(subDir, 'main.conf'), 'Host main')
    writeFileSync(join(subDir, 'extra.conf'), 'Host extra')

    const { matches, truncated } = globIncludePattern(
      `${root.replace(/\\/g, '/')}/*/{main,extra}.conf`
    )

    expect(truncated).toBe(false)
    expect(matches.some((entry) => entry.endsWith('main.conf'))).toBe(true)
    expect(matches.some((entry) => entry.endsWith('extra.conf'))).toBe(true)
  })

  it('drains queued trailing-glob matches when the entry budget runs out', () => {
    const root = makeTempTree()
    const confDir = join(root, 'conf.d')
    mkdirSync(confDir)
    // Direct writes (hard links cap out around 1023 per file on NTFS).
    for (let index = 0; index <= MAX_INCLUDE_GLOB_ENTRIES; index += 1) {
      writeFileSync(join(confDir, `${String(index).padStart(5, '0')}.conf`), 'x')
    }

    const { matches, truncated } = globIncludePattern(`${root.replace(/\\/g, '/')}/conf.d/**`)

    expect(truncated).toBe(true)
    // Every observed entry stays a match: the 4096 in-budget files plus conf.d
    // itself (the zero-directory alternative of a trailing `**`).
    expect(matches.length).toBe(MAX_INCLUDE_GLOB_ENTRIES + 1)
  })

  it('reports no truncation when the walk completes exactly at the entry budget', () => {
    const root = makeTempTree()
    const confDir = join(root, 'conf.d')
    mkdirSync(confDir)
    // Direct writes (hard links cap out around 1023 per file on NTFS).
    for (let index = 0; index < MAX_INCLUDE_GLOB_ENTRIES; index += 1) {
      writeFileSync(join(confDir, `${String(index).padStart(5, '0')}.conf`), 'x')
    }

    const { matches, truncated, truncationNote } = globIncludePattern(
      `${root.replace(/\\/g, '/')}/conf.d/*.conf`
    )

    // A walk that observes exactly the budget and drops nothing is complete;
    // only a real drop may claim the traversal stopped.
    expect(truncated).toBe(false)
    expect(truncationNote).toBeUndefined()
    expect(matches.length).toBe(MAX_INCLUDE_GLOB_ENTRIES)
  })

  it('does not log per-entry debug lines while walking', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempTree()
    mkdirSync(join(root, 'd'))
    writeFileSync(join(root, 'd', 'a.conf'), 'Host a')

    globIncludePattern(`${root.replace(/\\/g, '/')}/*/*.conf`)

    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('routes literal existence checks through the injected fs seam', () => {
    const root = makeTempTree()
    writeFileSync(join(root, 'main.conf'), 'Host main')

    const { matches } = globIncludePattern(`${root.replace(/\\/g, '/')}/main.conf`, {
      existsSync: () => false,
      opendirSync
    })

    expect(matches).toEqual([])
  })

  it('keeps comma-less brace groups literal instead of double-prefixing them', () => {
    const root = makeTempTree()
    writeFileSync(join(root, '{a}.conf'), 'Host a')
    writeFileSync(join(root, '{x}.confa'), 'Host xa')
    writeFileSync(join(root, '{x}.confb'), 'Host xb')

    const single = globIncludePattern(`${root.replace(/\\/g, '/')}/{a}.conf`)
    const mixed = globIncludePattern(`${root.replace(/\\/g, '/')}/{x}.conf{a,b}`)

    expect(single.matches).toEqual([`${root.replace(/\\/g, '/')}/{a}.conf`])
    expect(mixed.matches).toEqual([
      `${root.replace(/\\/g, '/')}/{x}.confa`,
      `${root.replace(/\\/g, '/')}/{x}.confb`
    ])
  })

  it('treats a leading caret in a character class as negation like globSync', () => {
    const root = makeTempTree()
    writeFileSync(join(root, 'a.txt'), 'x')
    writeFileSync(join(root, 'b.txt'), 'x')

    const { matches } = globIncludePattern(`${root.replace(/\\/g, '/')}/[^a]*`)

    expect(matches).toEqual([`${root.replace(/\\/g, '/')}/b.txt`])
  })

  it('drops alternatives with invalid character-class ranges instead of failing the pattern', () => {
    const root = makeTempTree()
    writeFileSync(join(root, 'b.txt'), 'x')

    const invalid = globIncludePattern(`${root.replace(/\\/g, '/')}/[z-a]*`)
    const mixed = globIncludePattern(`${root.replace(/\\/g, '/')}/{[z-a],b}*`)

    expect(invalid).toEqual({ matches: [], truncated: false })
    expect(mixed.matches).toEqual([`${root.replace(/\\/g, '/')}/b.txt`])
  })

  it('reports when brace expansion is capped', () => {
    const root = makeTempTree()
    const groups = '{1,2,3}{1,2,3}{1,2,3}{1,2,3}'

    const { matches, truncated, truncationNote } = globIncludePattern(
      `${root.replace(/\\/g, '/')}/${groups}/x.conf`
    )

    expect(matches).toEqual([])
    expect(truncated).toBe(true)
    expect(truncationNote).toBe(' (brace expansion stopped at 64 alternatives)')
  })

  it('matches pathological wildcard segments in linear time', () => {
    const root = makeTempTree()
    mkdirSync(join(root, 'd'))
    writeFileSync(join(root, 'd', `${'a'.repeat(48)}z`), 'x')
    writeFileSync(join(root, 'd', 'xaaxaaxaaxaaxaaxaab'), 'x')

    const started = Date.now()
    const { matches } = globIncludePattern(`${root.replace(/\\/g, '/')}/d/${'*a'.repeat(8)}*b`)
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(2000)
    expect(matches).toEqual([`${root.replace(/\\/g, '/')}/d/xaaxaaxaaxaaxaaxaab`])
  })

  it('matches dot entries when the wildcard segment itself starts with a dot', () => {
    const root = makeTempTree()
    writeFileSync(join(root, '.host1.conf'), 'Host dot')
    writeFileSync(join(root, 'host2.conf'), 'Host plain')

    const dotLeading = globIncludePattern(`${root.replace(/\\/g, '/')}/.host*.conf`)
    const bracketDot = globIncludePattern(`${root.replace(/\\/g, '/')}/[.]host*.conf`)

    expect(dotLeading.matches).toEqual([`${root.replace(/\\/g, '/')}/.host1.conf`])
    expect(bracketDot.matches).toEqual([`${root.replace(/\\/g, '/')}/.host1.conf`])
  })

  it('matches dot directories through a dot-leading mid-pattern segment', () => {
    const root = makeTempTree()
    mkdirSync(join(root, '.subdir'))
    writeFileSync(join(root, '.subdir', 'inner.conf'), 'Host inner')

    const { matches } = globIncludePattern(`${root.replace(/\\/g, '/')}/.*/inner.conf`)

    expect(matches).toEqual([`${root.replace(/\\/g, '/')}/.subdir/inner.conf`])
  })

  it('keeps implicit wildcards and recursion excluding dot entries', () => {
    const root = makeTempTree()
    writeFileSync(join(root, '.hidden.conf'), 'x')
    writeFileSync(join(root, 'visible.conf'), 'x')
    mkdirSync(join(root, '.sub'))
    writeFileSync(join(root, '.sub', 'hidden-inner.conf'), 'x')
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'inner.conf'), 'x')

    const rootPath = `${root.replace(/\\/g, '/')}`
    const baseNames = (result: { matches: string[] }) =>
      result.matches.map((path) => path.split(/[\\/]/).pop())

    expect(baseNames(globIncludePattern(`${rootPath}/*.conf`))).toEqual(['visible.conf'])
    expect(baseNames(globIncludePattern(`${rootPath}/**/*.conf`)).sort()).toEqual([
      'inner.conf',
      'visible.conf'
    ])
    const trailing = globIncludePattern(`${rootPath}/**`)
    expect(baseNames(trailing)).not.toContain('.hidden.conf')
    expect(trailing.matches.some((path) => path.includes('/.sub'))).toBe(false)
  })

  it('agrees with globSync across assorted segment shapes', () => {
    const root = makeTempTree()
    const dir = join(root, 'd')
    mkdirSync(dir)
    const names = [
      'a.txt',
      'b.txt',
      'ab.txt',
      'ba.txt',
      'z.txt',
      '^z.txt',
      'xaay.txt',
      'xaaby.txt',
      'cab1.txt',
      'cab2.txt',
      'daz.txt',
      'dbz.txt',
      `long${'a'.repeat(40)}z.txt`,
      'literal{a}.txt',
      '.dot.txt'
    ]
    for (const name of names) {
      writeFileSync(join(dir, name), 'x')
    }

    // Case-consistent patterns only: node's globSync is case-insensitive on
    // case-insensitive filesystems while this walker stays case-sensitive.
    const patterns = [
      '[^a]*',
      '[!a]*',
      '[a-b]*',
      '[b-d]*.txt',
      '*a*y',
      '*a*b*',
      '*a*a*a*a*a*y',
      '?.txt',
      'literal{a}.txt',
      '[z-a]*',
      '[c*]*',
      '*[0-9].txt',
      'xa?by.txt',
      '.*',
      '[.]*',
      '[!.]*',
      '.dot*',
      '?dot*'
    ]
    for (const pattern of patterns) {
      const expected = globSync(`${root.replace(/\\/g, '/')}/d/${pattern}`)
        .map((path) => path.split(/[\\/]/).pop())
        .sort()
      const { matches } = globIncludePattern(`${root.replace(/\\/g, '/')}/d/${pattern}`)
      const actual = matches.map((path) => path.split(/[\\/]/).pop()).sort()
      expect(actual, `pattern ${pattern}`).toEqual(expected)
    }
  })
})
