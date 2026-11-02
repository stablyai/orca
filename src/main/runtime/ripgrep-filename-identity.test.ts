import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { joinWorktreeRelativePath, normalizeRuntimeRelativePath } from './runtime-relative-paths'
import { normalizeQuickOpenRgLine } from '../../shared/quick-open-filter'

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
