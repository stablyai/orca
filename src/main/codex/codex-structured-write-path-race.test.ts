import { rename, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const roots: string[] = []
let afterOpen: (() => Promise<void>) | null = null

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof FsPromises>()
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args)
      await afterOpen?.()
      return handle
    }
  }
})

const { snapshotChanges } = await import('./codex-structured-write-manifest')

afterEach(() => {
  afterOpen = null
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
  roots.length = 0
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-write-path-race-'))
  roots.push(root)
  mkdirSync(join(root, 'source'), { recursive: true })
  return root
}

describe('Codex structured write manifest path races', () => {
  it('rejects a target replaced with a same-sized inode after it is opened', async () => {
    const root = fixtureRoot()
    const target = join(root, 'source', 'target.txt')
    const displaced = join(root, 'source', 'displaced.txt')
    writeFileSync(target, 'before\n')
    afterOpen = async () => {
      await rename(target, displaced)
      await writeFile(target, 'outside')
    }

    await expect(
      snapshotChanges(root, [
        { path: 'source/target.txt', diff: '@@ -1 +1 @@', kind: { type: 'update' } }
      ])
    ).rejects.toThrow('changed while being manifested')
    expect(readFileSync(target, 'utf8')).toBe('outside')
  })
})
