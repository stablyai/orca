import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  createPackagedRuntimeNodeModuleResources,
  prunePackagedIrohNapi
} = require('../packaged-runtime-node-modules.cjs')

it('includes @number0/iroh and its platform subpackage in the packaged runtime closure', () => {
  const packagedTargets = createPackagedRuntimeNodeModuleResources().map((resource) => resource.to)
  expect(packagedTargets).toContain(join('node_modules', '@number0', 'iroh'))
  expect(
    packagedTargets.some((target) => target.startsWith(join('node_modules', '@number0', 'iroh-')))
  ).toBe(true)
})

it('prunes non-target @number0/iroh platform subpackages from packaged runtime resources', async () => {
  const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-iroh-napi-prune-'))
  try {
    const scopeDir = join(resourcesDir, 'node_modules', '@number0')
    await mkdir(join(scopeDir, 'iroh'), { recursive: true })
    await mkdir(join(scopeDir, 'iroh-darwin-arm64'), { recursive: true })
    await mkdir(join(scopeDir, 'iroh-linux-x64-gnu'), { recursive: true })
    await mkdir(join(scopeDir, 'iroh-linux-arm64-musl'), { recursive: true })
    await mkdir(join(scopeDir, 'iroh-win32-x64-msvc'), { recursive: true })

    prunePackagedIrohNapi(resourcesDir, 'darwin', 'arm64')

    await expect(readdir(scopeDir).then((entries) => entries.sort())).resolves.toEqual([
      'iroh',
      'iroh-darwin-arm64'
    ])
  } finally {
    await rm(resourcesDir, { recursive: true, force: true })
  }
})
