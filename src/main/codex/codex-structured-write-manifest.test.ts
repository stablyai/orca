import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseFileChanges, snapshotChanges } from './codex-structured-write-manifest'

const roots: string[] = []

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
  roots.length = 0
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-write-manifest-'))
  roots.push(root)
  mkdirSync(join(root, 'source'), { recursive: true })
  return root
}

describe('Codex structured write manifest bounds', () => {
  it('rejects oversized change counts, paths, and aggregate diffs', () => {
    expect(
      parseFileChanges(
        Array.from({ length: 129 }, (_unused, index) => ({
          path: `source/${index}.ts`,
          diff: '+x',
          kind: { type: 'add' }
        }))
      )
    ).toBeNull()
    expect(parseFileChanges([{ path: 'x'.repeat(4_097), diff: '+x' }])).toBeNull()
    expect(
      parseFileChanges([{ path: 'source/x.ts', diff: 'x'.repeat(1024 * 1024 + 1) }])
    ).toBeNull()
    expect(parseFileChanges([{ path: 'source/\0x.ts', diff: '+x' }])).toBeNull()
  })

  it('refuses to read an oversized existing file into an enforcement receipt', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'source', 'large.bin'), Buffer.alloc(16 * 1024 * 1024 + 1))

    await expect(
      snapshotChanges(root, [
        { path: 'source/large.bin', diff: '@@ -1 +1 @@', kind: { type: 'update' } }
      ])
    ).rejects.toThrow('too large to manifest')
  })

  it('bounds aggregate bytes across an otherwise valid multi-file manifest', async () => {
    const root = fixtureRoot()
    for (const name of ['first.bin', 'second.bin']) {
      const path = join(root, 'source', name)
      writeFileSync(path, '')
      truncateSync(path, 16 * 1024 * 1024)
    }
    writeFileSync(join(root, 'source', 'overflow.bin'), 'x')

    await expect(
      snapshotChanges(
        root,
        ['first.bin', 'second.bin', 'overflow.bin'].map((name) => ({
          path: `source/${name}`,
          diff: '@@ -1 +1 @@',
          kind: { type: 'update' }
        }))
      )
    ).rejects.toThrow('aggregate byte limit')
  })

  it('produces a bounded digest record for a regular source file', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'source', 'small.ts'), 'export const value = 1\n')

    await expect(
      snapshotChanges(root, [
        { path: 'source/small.ts', diff: '@@ -1 +1 @@', kind: { type: 'update' } }
      ])
    ).resolves.toEqual([
      {
        path: 'source/small.ts',
        exists: true,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        bytes: 23
      }
    ])
  })
})
