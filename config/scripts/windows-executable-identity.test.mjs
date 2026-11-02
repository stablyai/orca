import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTree } from '../../src/shared/windows-transient-lock-removal.ts'

const require = createRequire(import.meta.url)
const {
  resolveWindowsExecutableName,
  writeWindowsExecutableIdentity
} = require('./windows-executable-identity.cjs')

const temporaryRoots = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => removeTree(root)))
})

async function makeFixture(executableName) {
  const appOutDir = await mkdtemp(join(tmpdir(), 'orca-windows-executable-identity-'))
  temporaryRoots.push(appOutDir)
  const resourcesDir = join(appOutDir, 'resources')
  await mkdir(resourcesDir)
  if (executableName) {
    await writeFile(join(appOutDir, executableName), '', 'utf8')
  }
  return { appOutDir, resourcesDir }
}

describe('Windows packaged executable identity', () => {
  it('uses electron-builder resolved productFilename', async () => {
    const fixture = await makeFixture('Phorca.exe')
    const executableName = writeWindowsExecutableIdentity({
      ...fixture,
      packager: {
        appInfo: { productFilename: 'Phorca' },
        platformSpecificBuildOptions: { executableName: 'Phorca / Internal' }
      }
    })

    expect(executableName).toBe('Phorca.exe')
    await expect(
      readFile(join(fixture.resourcesDir, 'app-executable-name.txt'), 'utf8')
    ).resolves.toBe('Phorca.exe\n')
  })

  it('uses productFilename for ordinary builds', async () => {
    const fixture = await makeFixture('Orca.exe')

    expect(
      writeWindowsExecutableIdentity({
        ...fixture,
        packager: { appInfo: { productFilename: 'Orca' }, platformSpecificBuildOptions: {} }
      })
    ).toBe('Orca.exe')
  })

  it('fails closed when the resolved executable is absent', async () => {
    const fixture = await makeFixture('Orca.exe')

    expect(() =>
      writeWindowsExecutableIdentity({
        ...fixture,
        packager: {
          appInfo: { productFilename: 'Phorca' },
          platformSpecificBuildOptions: { executableName: 'Phorca' }
        }
      })
    ).toThrow(/Missing packaged Windows executable: .*Phorca\.exe/)
  })

  it('normalizes an explicit exe suffix without duplicating it', () => {
    expect(
      resolveWindowsExecutableName({
        appInfo: { productFilename: 'Phorca.exe' },
        platformSpecificBuildOptions: { executableName: 'ignored.exe' }
      })
    ).toBe('Phorca.exe')
  })
})
