import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type * as FsPromisesModule from 'node:fs/promises'
import Module from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeHostTree, toHostRemovalPath } from './host-tree-removal'

const { nodeFsRm } = vi.hoisted(() => ({
  nodeFsRm: vi.fn()
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromisesModule>()
  nodeFsRm.mockImplementation(actual.rm)
  return { ...actual, rm: nodeFsRm }
})

const tempRoots: string[] = []

beforeEach(() => {
  nodeFsRm.mockClear()
})

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type NodeModuleLoader = {
  _load(request: string, parent: unknown, isMain: boolean): unknown
}

async function withOriginalFs<T>(exports: unknown, run: () => Promise<T>): Promise<T> {
  const loader = Module as unknown as NodeModuleLoader
  const originalLoad = loader._load
  loader._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
    if (request === 'original-fs') {
      return exports
    }
    return Reflect.apply(originalLoad, this, [request, parent, isMain])
  }
  try {
    return await run()
  } finally {
    loader._load = originalLoad
  }
}

describe('removeHostTree', () => {
  it('uses original-fs.promises.rm when original-fs is present', async () => {
    const originalFsRm = vi.fn().mockResolvedValue(undefined)
    const targetPath = join(tmpdir(), 'orca-host-tree-asar-probe')

    await withOriginalFs({ promises: { rm: originalFsRm } }, async () => {
      await removeHostTree(targetPath)
    })

    expect(originalFsRm).toHaveBeenCalledTimes(1)
    expect(originalFsRm).toHaveBeenCalledWith(
      toHostRemovalPath(targetPath),
      expect.objectContaining({ recursive: true, force: true })
    )
    expect(nodeFsRm).not.toHaveBeenCalled()
  })

  it('deletes a directory tree that contains .asar files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-host-tree-asar-'))
    tempRoots.push(root)
    const electronDist = join(root, 'node_modules', 'electron', 'dist')
    await mkdir(electronDist, { recursive: true })
    await writeFile(join(root, 'app.asar'), 'asar-archive')
    await writeFile(join(electronDist, 'default_app.asar'), 'default-app')
    await writeFile(join(root, 'readme.txt'), 'keep-not')

    await removeHostTree(root)

    expect(existsSync(root)).toBe(false)
    expect(existsSync(join(root, 'app.asar'))).toBe(false)
    expect(existsSync(join(electronDist, 'default_app.asar'))).toBe(false)
  })
})
