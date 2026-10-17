import { Dir, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createGlobReadabilityProofs,
  findGlobExpansionUncertainty,
  getLiteralGlobParent
} from './ssh-config-include-glob-readability'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true })
  }
  temporaryDirectories.length = 0
})

/**
 * The directory an empty `globSync` result has to be checked against. Worth its own test because
 * `dirname` alone is wrong for half of these: it steps a level too far up on a pattern whose literal
 * part ends at a separator, which would silently check the wrong directory's permissions.
 */
describe('getLiteralGlobParent', () => {
  it.each([
    ['/home/u/.ssh/config.d/*', '/home/u/.ssh/config.d'],
    ['/home/u/.ssh/config.d/5*.conf', '/home/u/.ssh/config.d'],
    ['/home/u/.ssh/config.d/**/*.conf', '/home/u/.ssh/config.d'],
    ['/home/u/.ssh/conf?g', '/home/u/.ssh'],
    ['/home/u/.ssh/[ab]*', '/home/u/.ssh'],
    // No metacharacter at all: callers only reach this for globs, but it must not invent a parent.
    ['/home/u/.ssh/config', '/home/u/.ssh'],
    ['/*', '/']
  ])('resolves %s to %s', (pattern, expected) => {
    expect(getLiteralGlobParent(pattern, posix)).toBe(expected)
  })

  it('keeps backslash-separated patterns in the Windows path space', () => {
    expect(getLiteralGlobParent('C:\\Users\\u\\.ssh\\config.d\\*', win32)).toBe(
      'C:\\Users\\u\\.ssh\\config.d'
    )
    // Windows accepts forward slashes too, and ssh_config is routinely written with them.
    expect(getLiteralGlobParent('C:/Users/u/.ssh/config.d/*.conf', win32)).toBe(
      'C:/Users/u/.ssh/config.d'
    )
  })
})

describe('findGlobExpansionUncertainty', () => {
  it('returns uncertainty instead of traversing past its synchronous path budget', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-ssh-glob-budget-'))
    temporaryDirectories.push(root)
    for (const name of ['one', 'two', 'three']) {
      const directory = join(root, name)
      mkdirSync(directory)
      writeFileSync(join(directory, 'config'), '')
    }
    const pattern = join(root, '*', 'config')

    // Only the literal parent's own open fits, so the glob traversal is what runs out.
    expect(findGlobExpansionUncertainty(pattern, posix, { maxPaths: 2 })).toEqual({
      reason: 'unproven-within-budget',
      target: pattern
    })
  })

  /**
   * Entries get their own budget because they are batched reads inside an already-open directory.
   * Charging them against the path budget reported a readable ~/.ssh holding a few hundred keys and
   * control sockets as unopenable, which permanently disabled the alias claim it feeds.
   */
  it('proves a directory holding far more entries than the path budget complete', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-ssh-glob-wide-'))
    temporaryDirectories.push(root)
    const matched = join(root, 'sub')
    mkdirSync(matched)
    writeFileSync(join(matched, 'config'), '')
    for (let index = 0; index < 302; index += 1) {
      writeFileSync(join(root, `id_key_${index}`), '')
    }

    expect(findGlobExpansionUncertainty(join(root, 'sub*', 'config'), posix)).toBeNull()
  })

  it('reports a directory past the entry budget as unproven rather than unreadable', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-ssh-glob-entries-'))
    temporaryDirectories.push(root)
    for (const name of ['one', 'two', 'three']) {
      writeFileSync(join(root, name), '')
    }

    expect(findGlobExpansionUncertainty(join(root, '*'), posix, { maxEntries: 2 })).toEqual({
      reason: 'unproven-within-budget',
      target: root
    })
  })

  it('proves a bounded readable glob complete', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-ssh-glob-readable-'))
    temporaryDirectories.push(root)
    const directory = join(root, 'one')
    mkdirSync(directory)
    writeFileSync(join(directory, 'config'), '')

    expect(
      findGlobExpansionUncertainty(join(root, '*', 'config'), posix, {
        maxPaths: 32
      })
    ).toBeNull()
  })

  it('keeps enumeration failures uncertain after the directory opens', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-ssh-glob-enumeration-'))
    temporaryDirectories.push(root)
    vi.spyOn(Dir.prototype, 'readSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('enumeration failed'), { code: 'EIO' })
    })

    expect(findGlobExpansionUncertainty(join(root, '*'), posix)).toEqual({
      reason: 'unreadable',
      target: root
    })
  })

  it('walks a directory once per expansion, so sibling Includes share the proof', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-ssh-glob-proofs-'))
    temporaryDirectories.push(root)
    writeFileSync(join(root, 'a-config'), '')
    writeFileSync(join(root, 'b-config'), '')
    const proofs = createGlobReadabilityProofs()

    expect(findGlobExpansionUncertainty(join(root, 'a*'), posix, { proofs })).toBeNull()

    // Any re-enumeration now fails, so a second null can only have come from the memo.
    vi.spyOn(Dir.prototype, 'readSync').mockImplementation(() => {
      throw Object.assign(new Error('enumeration failed'), { code: 'EIO' })
    })
    expect(findGlobExpansionUncertainty(join(root, 'b*'), posix, { proofs })).toBeNull()
    expect(findGlobExpansionUncertainty(join(root, 'b*'), posix)).not.toBeNull()
  })
})
