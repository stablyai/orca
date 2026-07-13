import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { listIndexableFiles, languageIdForPath } from './scan-worktree'

describe('scan-worktree', () => {
  it('lists supported files and skips node_modules/.git', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-scan-'))
    await writeFile(path.join(root, 'a.ts'), 'export const x = 1')
    await writeFile(path.join(root, 'readme.md'), '# hi')
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(path.join(root, 'node_modules', 'pkg', 'b.ts'), 'export const y = 2')
    await mkdir(path.join(root, '.git'), { recursive: true })
    await writeFile(path.join(root, '.git', 'c.ts'), 'export const z = 3')

    const files = await listIndexableFiles(root, { maxFiles: 100 })
    expect(files).toEqual([path.join(root, 'a.ts')])
  })

  it('maps extensions to language ids', () => {
    expect(languageIdForPath('/x/a.ts')).toBe('typescript')
    expect(languageIdForPath('/x/a.py')).toBe('python')
    expect(languageIdForPath('/x/a.md')).toBeNull()
  })
})
