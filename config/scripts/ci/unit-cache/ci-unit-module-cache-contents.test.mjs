import { mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  inventoryModuleCache,
  MODULE_CACHE_MANIFEST,
  sealModuleCache,
  validateModuleCache
} from './ci-unit-module-cache-contents.mjs'

const roots = []
const filename = 'a'.repeat(40)
const identity = {
  key: 'unit-module-v1-Linux-ARM64-runtime-config-lock',
  format: 'vitest-fs-1.0.0-beta.8',
  versions: { node: '24.21.0', bun: '1.4.3', vitest: '5.0.3' },
  sourceSha: 'b'.repeat(40),
  lockfileHash: '0028fbb2'
}

function moduleTable() {
  return [
    {
      file: '1',
      id: '1',
      url: '2',
      imports: '3',
      mappings: false,
      deps: '4',
      dynamicDeps: '5',
      staticMocks: '6',
      moduleType: '7'
    },
    '/workspace/src/main.ts',
    '/src/main.ts',
    { urls: '8', ids: '9' },
    ['10'],
    [],
    ['11'],
    'esm',
    ['10'],
    { '/dependency.ts': '12' },
    '/dependency.ts',
    { method: '13', specifier: '10', hasFactory: true, factoryLoadsOriginal: false },
    '/workspace/dependency.ts',
    'mock'
  ]
}

const moduleCode = (table = moduleTable()) =>
  `export const value = 1\n//# vitestCache=${Buffer.from(JSON.stringify(table)).toString('base64')}`

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'orca-unit-module-cache-'))
  roots.push(path)
  await writeFile(join(path, filename), moduleCode())
  await writeFile(
    join(path, '_metadata.json'),
    JSON.stringify({ lockfileHash: identity.lockfileHash })
  )
  return { path, ...identity }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('unit module cache contents', () => {
  it.each(['missing', 'modified', 'extra', 'renamed', 'metadata'])(
    'rejects %s sealed contents',
    async (change) => {
      const options = await fixture()
      await sealModuleCache(options)
      const path = join(options.path, filename)
      if (change === 'missing') {
        await rm(path)
      }
      if (change === 'modified') {
        await writeFile(path, moduleCode().replace('value = 1', 'value = 2'))
      }
      if (change === 'extra') {
        await writeFile(join(options.path, 'c'.repeat(40)), moduleCode())
      }
      if (change === 'renamed') {
        await rename(path, join(options.path, 'c'.repeat(40)))
      }
      if (change === 'metadata') {
        await writeFile(
          join(options.path, '_metadata.json'),
          JSON.stringify({ lockfileHash: identity.lockfileHash, changed: true })
        )
      }
      await expect(validateModuleCache(options)).rejects.toThrow(
        /cache (inventory|content) mismatch/
      )
    }
  )

  it.skipIf(process.platform === 'win32')(
    'rejects symlinked modules, manifests and cache roots',
    async () => {
      const options = await fixture()
      const outside = await fixture()
      await symlink(join(outside.path, filename), join(options.path, 'c'.repeat(40)))
      await expect(inventoryModuleCache(options)).rejects.toThrow('not a regular file')
      await rm(join(options.path, 'c'.repeat(40)))
      await symlink(join(outside.path, filename), join(options.path, MODULE_CACHE_MANIFEST))
      await expect(sealModuleCache(options)).rejects.toThrow('not a regular file')
      await symlink(options.path, join(outside.path, 'linked-root'))
      await expect(
        inventoryModuleCache({ ...options, path: join(outside.path, 'linked-root') })
      ).rejects.toThrow('cache root')
    }
  )
})
