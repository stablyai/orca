import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveMobileWebPackageRoot } from './mobile-web-package-root'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('mobile web package root', () => {
  it('uses an explicit development package override', async () => {
    const overrideRoot = await packageRoot('override')
    const resourcesPath = await packageRoot('resources')
    await addManifest(overrideRoot)
    await addManifest(join(resourcesPath, 'mobile-web'))

    expect(resolveMobileWebPackageRoot({ isPackaged: false, overrideRoot, resourcesPath })).toBe(
      overrideRoot
    )
  })

  it('locks packaged builds to the extra-resource directory', async () => {
    const overrideRoot = await packageRoot('override')
    const resourcesPath = await packageRoot('resources')
    const cwd = await packageRoot('checkout')
    await addManifest(overrideRoot)
    await addManifest(join(resourcesPath, 'mobile-web'))
    await addManifest(join(cwd, 'out', 'mobile-web-rnw'))

    expect(
      resolveMobileWebPackageRoot({ isPackaged: true, overrideRoot, resourcesPath, cwd })
    ).toBe(join(resourcesPath, 'mobile-web'))
  })

  it('does not fall back when packaged resources are missing', async () => {
    const overrideRoot = await packageRoot('override')
    const resourcesPath = await packageRoot('resources')
    const cwd = await packageRoot('checkout')
    await addManifest(overrideRoot)
    await addManifest(join(cwd, 'out', 'mobile-web-rnw'))

    expect(() =>
      resolveMobileWebPackageRoot({ isPackaged: true, overrideRoot, resourcesPath, cwd })
    ).toThrow('mobile_web_package_unavailable')
  })

  it('uses the development output and fails closed when no development output exists', async () => {
    const cwd = await packageRoot('checkout')
    const developmentRoot = join(cwd, 'out', 'mobile-web-rnw')
    await addManifest(developmentRoot)
    expect(resolveMobileWebPackageRoot({ isPackaged: false, cwd })).toBe(developmentRoot)

    const empty = await packageRoot('empty')
    expect(() => resolveMobileWebPackageRoot({ isPackaged: false, cwd: empty })).toThrow(
      'mobile_web_package_unavailable'
    )
  })
})

async function packageRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `orca-mobile-web-${name}-`))
  temporaryRoots.push(root)
  return root
}

async function addManifest(root: string): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'manifest.json'), '{}')
}
