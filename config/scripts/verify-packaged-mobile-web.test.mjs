import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { verifyPackagedMobileWeb } = require('./verify-packaged-mobile-web.cjs')
const temporaryRoots = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('packaged mobile web verification', () => {
  it('verifies the extra-resource tree rather than the source checkout output', async () => {
    const resourcesDir = await createResourcesDirectory()
    const packageRoot = join(resourcesDir, 'mobile-web')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'manifest.json'), '{}')
    const run = vi.fn()

    expect(
      verifyPackagedMobileWeb(resourcesDir, {
        execFileSync: run,
        verifierPath: '/checkout/config/scripts/verify-mobile-web-rnw-build.mjs'
      })
    ).toBe(packageRoot)
    expect(run).toHaveBeenCalledWith(
      process.execPath,
      [
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        '/checkout/config/scripts/verify-mobile-web-rnw-build.mjs',
        '--root',
        packageRoot
      ],
      { stdio: 'inherit' }
    )
  })

  it('fails packaging when the copied manifest is absent', async () => {
    const resourcesDir = await createResourcesDirectory()

    expect(() => verifyPackagedMobileWeb(resourcesDir, { execFileSync: vi.fn() })).toThrow(
      'Packaged mobile web manifest is missing'
    )
  })
})

async function createResourcesDirectory() {
  const root = await mkdtemp(join(tmpdir(), 'orca-packaged-mobile-web-'))
  temporaryRoots.push(root)
  return root
}
