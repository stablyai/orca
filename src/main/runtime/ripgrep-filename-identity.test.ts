import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { joinWorktreeRelativePath, normalizeRuntimeRelativePath } from './runtime-relative-paths'
import { buildExcludePathPrefixes, normalizeQuickOpenRgLine } from '../../shared/quick-open-filter'
import { createAccumulator, ingestRgJsonLine } from '../../shared/text-search'

it.each(['/native/repo\\root', '/ssh/repo\\root'])(
  'preserves POSIX search identities under %s independently of client platform',
  (root) => {
    const acc = createAccumulator()
    for (const name of ['a\\b.txt', 'a/b.txt']) {
      const relative = normalizeQuickOpenRgLine(`./${name}`, { kind: 'cwd-relative' })
      expect(relative).toBe(name)
      expect(
        normalizeQuickOpenRgLine(`${root}/${name}`, { kind: 'absolute', rootPath: root })
      ).toBe(name)
      expect(joinWorktreeRelativePath(root, normalizeRuntimeRelativePath(name, root))).toBe(
        `${root}/${name}`
      )
      ingestRgJsonLine(
        JSON.stringify({
          type: 'match',
          data: {
            path: { text: `${root}/${name}` },
            lines: { text: 'needle' },
            line_number: 1,
            submatches: [{ start: 0, end: 6 }]
          }
        }),
        root,
        acc,
        10
      )
    }
    expect([...acc.fileMap.values()].map((file) => file.relativePath)).toEqual([
      'a\\b.txt',
      'a/b.txt'
    ])
    expect(buildExcludePathPrefixes(root, [`${root}/a\\b`])).toEqual(['a\\b'])
  }
)

it.each(['C:\\repo', '\\\\server\\share\\repo'])(
  'preserves Windows separator compatibility under %s',
  (root) => {
    expect(joinWorktreeRelativePath(root, normalizeRuntimeRelativePath('a\\b.txt', root))).toBe(
      `${root}\\a\\b.txt`
    )
    expect(
      normalizeQuickOpenRgLine(`${root}\\a\\b.txt`, { kind: 'absolute', rootPath: root })
    ).toBe('a/b.txt')
  }
)

describe.skipIf(process.platform === 'win32')('real POSIX filename collision', () => {
  it('opens both literal-backslash and nested files without changing identity', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'orca-rg-path-'))
    const root = join(parent, 'repo\\root')
    try {
      await mkdir(join(root, 'a'), { recursive: true })
      await writeFile(join(root, 'a\\b.txt'), 'literal')
      await writeFile(join(root, 'a/b.txt'), 'nested')
      for (const [name, expected] of [
        ['a\\b.txt', 'literal'],
        ['a/b.txt', 'nested']
      ]) {
        const relative = normalizeQuickOpenRgLine(`./${name}`, { kind: 'cwd-relative' })
        expect(relative).toBe(name)
        expect(
          await readFile(
            joinWorktreeRelativePath(root, normalizeRuntimeRelativePath(name, root)),
            'utf8'
          )
        ).toBe(expected)
      }
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})
