import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeTree } from '../../src/shared/windows-transient-lock-removal.ts'

const require = createRequire(import.meta.url)
const { copyFiles, FileMatcher } = require('app-builder-lib/out/fileMatcher')
const { createPackagedRuntimeNodeModuleResources } = require('../packaged-runtime-node-modules.cjs')
const {
  RUNTIME_PACKAGE_EXCLUDED_FILES,
  assertNoWindowsExecutablesInRuntimeNodeModules,
  runtimePackageExcludeFilter
} = require('../packaged-windows-only-runtime-files.cjs')

const ssh2Target = join('node_modules', 'ssh2')
const { everyPlatform, nonWindows } = RUNTIME_PACKAGE_EXCLUDED_FILES.ssh2

async function withTempDir(prefix, run) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  try {
    await run(dir)
  } finally {
    await removeTree(dir)
  }
}

// Copies the installed ssh2 package the way electron-builder applies an extraResources entry,
// then reports which of its excluded files survived.
async function copiedSsh2ExcludedFiles(resource, destinationRoot) {
  const destination = join(destinationRoot, resource.to)
  await copyFiles([new FileMatcher(resource.from, destination, (value) => value, resource.filter)])
  return [...everyPlatform, ...nonWindows].filter((file) => existsSync(join(destination, file)))
}

function peImage() {
  const image = Buffer.alloc(0x80)
  image.write('MZ', 0, 'latin1')
  image.writeUInt32LE(0x40, 0x3c)
  image.write('PE\0\0', 0x40, 'latin1')
  image.writeUInt16LE(0x14c, 0x44)
  return image
}

describe('Windows-only runtime files', () => {
  it.each(['darwin', 'linux'])('keeps ssh2 Pageant files out of the %s copy', async (platform) => {
    const resource = createPackagedRuntimeNodeModuleResources(platform).find(
      (entry) => entry.to === ssh2Target
    )
    // Why: the fixture must be the real package, so a bump that moves these files is noticed here.
    for (const file of [...everyPlatform, ...nonWindows]) {
      expect(existsSync(join(resource.from, file)), file).toBe(true)
    }
    expect(nonWindows).toContain('util/pagent.exe')
    await withTempDir('orca-ssh2-copy-', async (dir) => {
      expect(await copiedSsh2ExcludedFiles(resource, dir)).toEqual([])
      expect(existsSync(join(dir, ssh2Target, 'lib', 'agent.js'))).toBe(true)
    })
  })

  it('keeps pagent.exe for Pageant on Windows but drops its build inputs', async () => {
    // Why the linux entry: the win32 plan resolves Windows-only addons absent on other hosts.
    const { from } = createPackagedRuntimeNodeModuleResources('linux').find(
      (entry) => entry.to === ssh2Target
    )
    const resource = { from, to: ssh2Target, filter: runtimePackageExcludeFilter('ssh2', 'win32') }
    await withTempDir('orca-ssh2-copy-win-', async (dir) => {
      expect(await copiedSsh2ExcludedFiles(resource, dir)).toEqual(nonWindows)
    })
  })

  it('fails a non-Windows package that ships a Windows executable under any name', async () => {
    await withTempDir('orca-windows-exe-', async (resourcesDir) => {
      const nested = join(resourcesDir, 'node_modules', 'some-dep', 'bin')
      await mkdir(nested, { recursive: true })
      await writeFile(join(nested, 'helper'), peImage())
      // An MZ prefix alone is not a PE image; data files must not trip the check.
      await writeFile(join(nested, 'fake.exe'), Buffer.from('MZ not really'))

      for (const platform of ['darwin', 'linux']) {
        expect(() =>
          assertNoWindowsExecutablesInRuntimeNodeModules(resourcesDir, platform)
        ).toThrow(/: node_modules\/some-dep\/bin\/helper\. /)
      }
      expect(() =>
        assertNoWindowsExecutablesInRuntimeNodeModules(resourcesDir, 'win32')
      ).not.toThrow()
    })
  })
})
