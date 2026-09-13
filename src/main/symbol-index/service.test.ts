import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SymbolIndexService } from './service'

describe('SymbolIndexService', () => {
  const createdRoots: string[] = []
  const makeRoot = async (prefix = 'orca-svc-'): Promise<string> => {
    const root = await mkdtemp(path.join(tmpdir(), prefix))
    createdRoots.push(root)
    return root
  }
  afterEach(async () => {
    await Promise.all(
      createdRoots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
    )
  })

  it('indexes a worktree and answers findDefinitions; unknown symbol is empty', async () => {
    const root = await makeRoot()
    await writeFile(path.join(root, 'a.ts'), 'export function target() {}')
    const svc = new SymbolIndexService({ maxFiles: 100 })
    await svc.ensureIndexed('w1', root)

    const hit = await svc.findDefinitions({
      worktreeId: 'w1',
      worktreeRoot: root,
      symbol: 'target'
    })
    expect(hit.status).toBe('ready')
    expect(hit.definitions.map((d) => d.name)).toEqual(['target'])
    expect(hit.definitions[0]!.path).toBe(path.join(root, 'a.ts'))

    const miss = await svc.findDefinitions({ worktreeId: 'w1', worktreeRoot: root, symbol: 'nope' })
    expect(miss).toEqual({ status: 'ready', definitions: [] })
    svc.dispose()
  })

  it('skips indexing a file larger than the size cap', async () => {
    const root = await makeRoot('orca-svc-size-')
    const big = path.join(root, 'big.ts')
    // MAX_INDEXABLE_FILE_BYTES is 2_000_000 bytes; pad well past it so the
    // size check trips regardless of the exact trailing-comment overhead.
    const content = `export function hugeSymbol() {}\n// ${'x'.repeat(2_100_000)}`
    await writeFile(big, content)
    const svc = new SymbolIndexService({ maxFiles: 100 })
    await svc.ensureIndexed('w1', root)

    const res = await svc.findDefinitions({
      worktreeId: 'w1',
      worktreeRoot: root,
      symbol: 'hugeSymbol'
    })
    expect(res).toEqual({ status: 'ready', definitions: [] })
    svc.dispose()
  })

  it('reflects file changes incrementally', async () => {
    const root = await makeRoot()
    const file = path.join(root, 'a.ts')
    await writeFile(file, 'export function one() {}')
    const svc = new SymbolIndexService({ maxFiles: 100 })
    await svc.ensureIndexed('w1', root)

    await writeFile(file, 'export function two() {}')
    await svc.onFileChanged('w1', root, file)

    expect(
      (await svc.findDefinitions({ worktreeId: 'w1', worktreeRoot: root, symbol: 'one' }))
        .definitions
    ).toEqual([])
    expect(
      (await svc.findDefinitions({ worktreeId: 'w1', worktreeRoot: root, symbol: 'two' }))
        .definitions.length
    ).toBe(1)
    svc.dispose()
  })

  it('drops stale symbols when a previously-indexed file is deleted', async () => {
    const root = await makeRoot()
    const file = path.join(root, 'a.ts')
    await writeFile(file, 'export function staleSym() {}')
    const svc = new SymbolIndexService({ maxFiles: 100 })
    await svc.ensureIndexed('w1', root)
    expect(
      (await svc.findDefinitions({ worktreeId: 'w1', worktreeRoot: root, symbol: 'staleSym' }))
        .definitions.length
    ).toBe(1)

    await rm(file)
    await svc.onFileChanged('w1', root, file)

    expect(
      (await svc.findDefinitions({ worktreeId: 'w1', worktreeRoot: root, symbol: 'staleSym' }))
        .definitions
    ).toEqual([])
    svc.dispose()
  })

  it('drops stale symbols when a previously-indexed file grows past the size cap', async () => {
    const root = await makeRoot()
    const file = path.join(root, 'a.ts')
    await writeFile(file, 'export function bigStale() {}')
    const svc = new SymbolIndexService({ maxFiles: 100 })
    await svc.ensureIndexed('w1', root)
    expect(
      (await svc.findDefinitions({ worktreeId: 'w1', worktreeRoot: root, symbol: 'bigStale' }))
        .definitions.length
    ).toBe(1)

    // Grow the file past MAX_INDEXABLE_FILE_BYTES (2MB) so re-index skips it.
    await writeFile(file, `export function bigStale() {}\n// ${'x'.repeat(2_100_000)}`)
    await svc.onFileChanged('w1', root, file)

    expect(
      (await svc.findDefinitions({ worktreeId: 'w1', worktreeRoot: root, symbol: 'bigStale' }))
        .definitions
    ).toEqual([])
    svc.dispose()
  })
})
