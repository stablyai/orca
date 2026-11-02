import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  inventoryModuleCache,
  MODULE_CACHE_LIMITS,
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

async function changeManifest(options, change) {
  const path = join(options.path, MODULE_CACHE_MANIFEST)
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  change(manifest)
  await writeFile(path, JSON.stringify(manifest))
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('unit module cache contents', () => {
  it('seals all transformed files and Vitest metadata with exact content hashes', async () => {
    const options = await fixture()
    const inventory = await inventoryModuleCache(options)
    expect(inventory.entries.map((entry) => entry.name)).toEqual(['_metadata.json', filename])
    expect(inventory.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true)
    expect(inventory.totalBytes).toBe(
      inventory.entries.reduce((sum, entry) => sum + entry.bytes, 0)
    )
    const manifest = await sealModuleCache(options)
    expect(manifest).toMatchObject({ version: 1, ...identity, ...inventory })
    expect(await validateModuleCache(options)).toEqual(manifest)
    const restoreOptions = { ...options, sourceSha: undefined }
    expect(await validateModuleCache(restoreOptions)).toEqual(manifest)
  })

  it('accepts absent optional module type, dependency lists and mocks', async () => {
    const options = await fixture()
    await writeFile(
      join(options.path, filename),
      moduleCode([
        { id: '1', url: '2', file: null, imports: '3', mappings: false },
        '\u0000virtual-module',
        '/@id/virtual-module',
        { urls: '4', ids: '5' },
        [],
        {}
      ])
    )
    await sealModuleCache(options)
    await expect(validateModuleCache(options)).resolves.toMatchObject({ key: identity.key })
  })

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

  it.each([
    ['key', 'different-key'],
    ['format', 'different-format'],
    ['sourceSha', 'd'.repeat(40)],
    ['lockfileHash', '12345678'],
    ['version', 2],
    ['versions', { ...identity.versions, bun: '1.4.4' }]
  ])('rejects mismatched manifest %s', async (field, value) => {
    const options = await fixture()
    await sealModuleCache(options)
    await changeManifest(options, (manifest) => {
      manifest[field] = value
    })
    await expect(validateModuleCache(options)).rejects.toThrow(/identity mismatch/)
  })

  it.each(['missing', 'malformed', 'mismatched'])(
    'rejects %s Vitest metadata before sealing',
    async (kind) => {
      const options = await fixture()
      const path = join(options.path, '_metadata.json')
      if (kind === 'missing') {
        await rm(path)
      }
      if (kind === 'malformed') {
        await writeFile(path, '{')
      }
      if (kind === 'mismatched') {
        await writeFile(path, '{"lockfileHash":"12345678"}')
      }
      await expect(sealModuleCache(options)).rejects.toThrow()
    }
  )

  it.each(['.tmp-partial', 'invalid-module.js', 'B'.repeat(40)])(
    'rejects invalid filename %s',
    async (name) => {
      const options = await fixture()
      await writeFile(join(options.path, name), moduleCode())
      await expect(inventoryModuleCache(options)).rejects.toThrow('invalid cache entry name')
    }
  )

  it('rejects a directory masquerading as a transformed file', async () => {
    const options = await fixture()
    await mkdir(join(options.path, 'c'.repeat(40)))
    await expect(inventoryModuleCache(options)).rejects.toThrow('not a regular file')
  })

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

  it('rejects oversized entries before allocating their contents', async () => {
    const options = await fixture()
    await truncate(join(options.path, filename), MODULE_CACHE_LIMITS.entryBytes + 1)
    await expect(inventoryModuleCache(options)).rejects.toThrow('invalid file size')
  })

  it.each([
    ['missing trailer', 'export const value = 1'],
    ['invalid base64', 'x\n//# vitestCache=***'],
    ['noncanonical base64', 'x\n//# vitestCache=W10'],
    ['invalid JSON', 'x\n//# vitestCache=ew=='],
    ['plain JSON object', `x\n//# vitestCache=${Buffer.from('{}').toString('base64')}`]
  ])('rejects %s', async (_label, code) => {
    const options = await fixture()
    await writeFile(join(options.path, filename), code)
    await expect(sealModuleCache(options)).rejects.toThrow()
  })

  it.each([
    [
      'out-of-range reference',
      (table) => {
        table[0].id = '999'
      }
    ],
    [
      'noncanonical reference',
      (table) => {
        table[0].id = '01'
      }
    ],
    [
      'numeric id',
      (table) => {
        table[0].id = 1
      }
    ],
    [
      'cyclic imports',
      (table) => {
        table[0].imports = '0'
      }
    ],
    [
      'invalid mappings',
      (table) => {
        table[0].mappings = null
      }
    ],
    [
      'invalid module type',
      (table) => {
        table[7] = 'unknown'
      }
    ],
    [
      'invalid import URL',
      (table) => {
        table[8][0] = false
      }
    ],
    [
      'invalid import ids',
      (table) => {
        table[9]['/dependency.ts'] = 4
      }
    ],
    [
      'invalid dependencies',
      (table) => {
        table[4][0] = false
      }
    ],
    [
      'invalid static mocks',
      (table) => {
        table[11].hasFactory = 1
      }
    ],
    [
      'inline object',
      (table) => {
        table[0].imports = {}
      }
    ],
    [
      'unsafe property',
      (table) => {
        table[0] = JSON.parse('{"__proto__":"0"}')
      }
    ]
  ])('rejects %s in module metadata', async (_label, mutate) => {
    const options = await fixture()
    const table = moduleTable()
    mutate(table)
    await writeFile(join(options.path, filename), moduleCode(table))
    await expect(sealModuleCache(options)).rejects.toThrow()
  })
})
