import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { listIndexableFiles, languageIdForPath } from './scan-worktree'

describe('scan-worktree', () => {
  const createdRoots: string[] = []
  const makeRoot = async (prefix = 'orca-scan-'): Promise<string> => {
    const root = await mkdtemp(path.join(tmpdir(), prefix))
    createdRoots.push(root)
    return root
  }
  afterEach(async () => {
    await Promise.all(createdRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
  })

  it('lists supported files and skips node_modules/.git', async () => {
    const root = await makeRoot()
    await writeFile(path.join(root, 'a.ts'), 'export const x = 1')
    await writeFile(path.join(root, 'readme.md'), '# hi')
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(path.join(root, 'node_modules', 'pkg', 'b.ts'), 'export const y = 2')
    await mkdir(path.join(root, '.git'), { recursive: true })
    await writeFile(path.join(root, '.git', 'c.ts'), 'export const z = 3')

    const files = await listIndexableFiles(root, { maxFiles: 100 })
    expect(files).toEqual([path.join(root, 'a.ts')])
  })

  it('bounds directory traversal via maxDirs before maxFiles', async () => {
    const root = await makeRoot('orca-scan-dirs-')
    for (let i = 0; i < 5; i++) {
      const sub = path.join(root, `d${i}`)
      await mkdir(sub, { recursive: true })
      await writeFile(path.join(sub, 'f.ts'), 'export const x = 1')
    }

    const files = await listIndexableFiles(root, { maxFiles: 100, maxDirs: 3 })
    expect(files.length).toBeGreaterThan(0)
    expect(files.length).toBeLessThanOrEqual(3)
  })

  it('maps extensions to language ids', () => {
    expect(languageIdForPath('/x/a.ts')).toBe('typescript')
    expect(languageIdForPath('/x/a.py')).toBe('python')
    expect(languageIdForPath('/x/a.md')).toBeNull()
  })
})
