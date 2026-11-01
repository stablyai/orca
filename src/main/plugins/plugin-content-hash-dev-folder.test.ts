import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hashPluginTree, MAX_PLUGIN_FILES } from './plugin-content-hash'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function devFolder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-dev-hash-'))
  roots.push(root)
  await writeFile(join(root, 'orca-plugin.json'), '{}')
  await mkdir(join(root, 'src', 'node_modules'), { recursive: true })
  await writeFile(join(root, 'src', 'node_modules', 'kept.js'), 'nested is plugin content')
  return root
}

describe('hashPluginTree devFolder', () => {
  it('ignores the root .orca/ and node_modules/ of a dev folder, whatever their size', async () => {
    const root = await devFolder()
    const before = await hashPluginTree(root, { devFolder: true })
    await mkdir(join(root, '.orca', 'types'), { recursive: true })
    await writeFile(join(root, '.orca', 'types', 'orca.d.ts'), 'declare module "orca" {}')
    await mkdir(join(root, 'node_modules'))
    await Promise.all(
      Array.from({ length: MAX_PLUGIN_FILES + 1 }, (_, index) =>
        writeFile(join(root, 'node_modules', `${index}.js`), '')
      )
    )
    const after = await hashPluginTree(root, { devFolder: true })
    expect(after).toEqual(before)
    expect(after).toMatchObject({ ok: true, fileCount: 2 })
  })

  it('still hashes them for installs', async () => {
    const root = await devFolder()
    const before = await hashPluginTree(root)
    await mkdir(join(root, '.orca'))
    await writeFile(join(root, '.orca', 'x'), 'x')
    const after = await hashPluginTree(root)
    expect(after.ok && before.ok && after.hash !== before.hash).toBe(true)
  })
})
