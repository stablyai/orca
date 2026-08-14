import { linkSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
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
    expect(
      parseFileChanges([{ path: 'x'.repeat(4_097), diff: '+x', kind: { type: 'update' } }])
    ).toBeNull()
    expect(
      parseFileChanges([
        {
          path: 'source/x.ts',
          diff: 'x'.repeat(1024 * 1024 + 1),
          kind: { type: 'update' }
        }
      ])
    ).toBeNull()
    expect(
      parseFileChanges([
        { path: 'source/x.ts', diff: '\u0001'.repeat(400_000), kind: { type: 'update' } }
      ])
    ).toBeNull()
    expect(
      parseFileChanges([{ path: 'source/\0x.ts', diff: '+x', kind: { type: 'update' } }])
    ).toBeNull()
  })

  it('rejects cyclic, deep, accessor, exotic, and oversized change metadata before digesting', () => {
    const cyclic: Record<string, unknown> = { type: 'update' }
    cyclic.self = cyclic
    let deep: Record<string, unknown> = { type: 'update' }
    for (let index = 0; index < 33; index += 1) {
      deep = { child: deep }
    }
    const accessor = Object.defineProperty({}, 'type', {
      enumerable: true,
      get: () => 'update'
    })
    const sparse: unknown[] = []
    sparse.length = 16_385
    const tooManyNodes = Array.from({ length: 16_384 }, () => null)

    for (const kind of [
      cyclic,
      deep,
      accessor,
      new Date(),
      sparse,
      tooManyNodes,
      { payload: 'x'.repeat(2 * 1024 * 1024) },
      undefined,
      BigInt(1),
      Number.NaN,
      Number.POSITIVE_INFINITY
    ]) {
      expect(parseFileChanges([{ path: 'source/x.ts', diff: '+x', kind }])).toBeNull()
    }
  })

  it('clones bounded forward-compatible metadata without retaining mutable input identity', () => {
    const kind = {
      type: 'future-kind',
      metadata: { flags: [true, 2, 'three', null] },
      ['__proto__']: { retainedAsData: true }
    }
    const parsed = parseFileChanges([{ path: 'source/x.ts', diff: '+x', kind }])

    expect(parsed).toEqual([{ path: 'source/x.ts', diff: '+x', kind }])
    expect(parsed?.[0]?.kind).not.toBe(kind)
    kind.metadata.flags[0] = false
    expect(parsed?.[0]?.kind).toEqual({
      type: 'future-kind',
      metadata: { flags: [true, 2, 'three', null] },
      ['__proto__']: { retainedAsData: true }
    })
  })

  it('reserves queued sibling nodes before traversing another wide nested container', () => {
    const wide = (child: unknown): unknown[] => [
      child,
      ...Array.from({ length: 5_800 }, () => null)
    ]
    let traversedOverBudgetContainer = false
    const guarded = new Proxy(wide(null), {
      ownKeys: (target) => {
        traversedOverBudgetContainer = true
        return Reflect.ownKeys(target)
      }
    })

    expect(
      parseFileChanges([{ path: 'source/x.ts', diff: '+x', kind: wide(wide(guarded)) }])
    ).toBeNull()
    expect(traversedOverBudgetContainer).toBe(false)
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

  it('rejects a hard link whose inode can also be mutated outside the bounded root', async () => {
    const root = fixtureRoot()
    const outside = join(root, '..', 'outside.txt')
    writeFileSync(outside, 'outside\n')
    linkSync(outside, join(root, 'source', 'linked.txt'))

    await expect(
      snapshotChanges(root, [
        { path: 'source/linked.txt', diff: '@@ -1 +1 @@', kind: { type: 'update' } }
      ])
    ).rejects.toThrow('multiple hard links')
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
