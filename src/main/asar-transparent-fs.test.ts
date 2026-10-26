import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { rm } from './asar-transparent-fs'

// Plain Node tests fallback; host-tree-removal-asar.electron.test.ts verifies Electron’s asar behavior.
const roots: string[] = []

afterAll(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

describe('asar-transparent rm', () => {
  it('removes a tree recursively where `original-fs` is unresolvable', async () => {
    expect(process.versions.electron).toBeUndefined()
    const root = await mkdtemp(join(tmpdir(), 'orca-asar-transparent-'))
    roots.push(root)
    const target = join(root, 'wt-1700000000000-abcdef01')
    await mkdir(join(target, 'nested'), { recursive: true })
    await writeFile(join(target, 'nested', 'file.txt'), 'x', 'utf8')

    await expect(rm(target, { recursive: true, force: true })).resolves.toBeUndefined()

    expect(existsSync(target)).toBe(false)
    expect(existsSync(root)).toBe(true)
  })

  it('honours `force: false` rather than swallowing a missing path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-asar-transparent-'))
    roots.push(root)

    await expect(rm(join(root, 'absent'), { recursive: true })).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})
