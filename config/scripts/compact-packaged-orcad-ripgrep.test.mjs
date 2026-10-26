import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assembleOrcadArtifact } from '../../src/main/orcad/orcad-artifact-materializer.ts'
import { readOrcadArtifactIdentity } from '../../src/main/orcad/orcad-artifact-identity.ts'
import {
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  orcadRipgrepArtifact
} from '../../src/shared/orcad-artifacts.ts'
import { writeOrcadTemplateTestFixture } from './orcad-template-test-fixture.mjs'

const require = createRequire(import.meta.url)
const { compactPackagedOrcadRipgrep } = require('./compact-packaged-orcad-ripgrep.cjs')
const { verifyPackagedOrcadTemplate } = require('./verify-packaged-orcad-template.cjs')
const {
  finalizePackagedOrcadTemplate,
  resealSignedWindowsApp
} = require('./packaged-orcad-template.cjs')
const roots = []
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const appDir = await mkdtemp(join(tmpdir(), 'orca-compact-ripgrep-'))
  roots.push(appDir)
  const resourcesDir = join(appDir, 'resources')
  const templateDir = await writeOrcadTemplateTestFixture(resourcesDir, { compat: true })
  const manifestPath = join(templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const [target, entry] of Object.entries(manifest.targets)) {
    const filename = orcadRipgrepArtifact(target)
    const desktop = join(resourcesDir, filename)
    await mkdir(dirname(desktop), { recursive: true })
    const bytes = Buffer.from(`${filename}:static binary`)
    await writeFile(desktop, bytes)
    await writeFile(join(templateDir, 'targets', target, filename), bytes)
    entry.files[filename] = hash(bytes)
  }
  await writeFile(manifestPath, JSON.stringify(manifest))
  return { appDir, resourcesDir, templateDir, manifest, manifestPath }
}

describe('packaged ripgrep storage', () => {
  it('preserves every deployed slot byte and version, including old schema 3 templates', async () => {
    const f = await fixture()
    const original = new Map()
    const cacheRoot = join(f.appDir, 'cache')
    for (const target of Object.keys(f.manifest.targets)) {
      const slot = await assembleOrcadArtifact({ templateDir: f.templateDir, cacheRoot, target })
      original.set(target, basename(slot))
    }
    expect(compactPackagedOrcadRipgrep(f.resourcesDir)).toBeGreaterThan(0)
    expect(compactPackagedOrcadRipgrep(f.resourcesDir)).toBe(0)
    for (const target of Object.keys(f.manifest.targets)) {
      const slot = await assembleOrcadArtifact({
        templateDir: f.templateDir,
        cacheRoot: join(f.appDir, 'fresh-cache'),
        target
      })
      expect(basename(slot)).toBe(original.get(target))
      expect(await readOrcadArtifactIdentity(slot)).toBe(original.get(target))
      const filename = orcadRipgrepArtifact(target)
      expect(await readFile(join(slot, filename))).toEqual(
        await readFile(join(f.resourcesDir, filename))
      )
      if (process.platform !== 'win32' && !target.startsWith('win32-')) {
        expect((await stat(join(slot, filename))).mode & 0o777).toBe(0o755)
      }
      expect(existsSync(join(f.templateDir, 'targets', target, filename))).toBe(
        target.startsWith('darwin-')
      )
    }
    // No template storage schema reaches the deployment slot.
    expect(
      existsSync(
        join(
          cacheRoot,
          'linux-x64-glibc',
          original.get('linux-x64-glibc'),
          ORCAD_TEMPLATE_MANIFEST_FILENAME
        )
      )
    ).toBe(false)
  })

  it('compacts through the real desktop finalization hook', async () => {
    const f = await fixture()
    await finalizePackagedOrcadTemplate(f.resourcesDir, {
      platform: 'linux',
      signMacBinary: vi.fn()
    })
    const manifest = JSON.parse(await readFile(f.manifestPath, 'utf8'))
    expect(manifest.schemaVersion).toBe(4)
    expect(manifest.targets['linux-x64-glibc'].packagedRipgrep).toBe(true)
    expect(existsSync(join(f.templateDir, 'targets/linux-x64-glibc/ripgrep/linux-x64/rg'))).toBe(
      false
    )
  })

  it('keeps binaries that differ and never removes Darwin signing inputs', async () => {
    const f = await fixture()
    const desktop = join(f.resourcesDir, 'ripgrep/linux-arm64/rg')
    await writeFile(desktop, 'different desktop bytes')
    compactPackagedOrcadRipgrep(f.resourcesDir)
    const manifest = JSON.parse(await readFile(f.manifestPath, 'utf8'))
    expect(manifest.schemaVersion).toBe(4)
    for (const [target, entry] of Object.entries(manifest.targets)) {
      expect(entry.packagedRipgrep).toBe(
        target.startsWith('darwin-') || target.startsWith('linux-arm64') ? undefined : true
      )
    }
    expect(await readFile(desktop, 'utf8')).toBe('different desktop bytes')
  })

  it('does not launder corrupted target bytes while removing duplicates', async () => {
    const f = await fixture()
    await writeFile(join(f.templateDir, 'targets/linux-x64-glibc/ripgrep/linux-x64/rg'), 'tampered')
    expect(() => compactPackagedOrcadRipgrep(f.resourcesDir)).toThrow('checksum mismatch')
  })

  it.each(['tampered', 'missing'])('rejects %s shared bytes before deploying', async (damage) => {
    const f = await fixture()
    compactPackagedOrcadRipgrep(f.resourcesDir)
    const shared = join(f.resourcesDir, 'ripgrep/linux-x64/rg')
    await (damage === 'missing' ? rm(shared) : writeFile(shared, 'tampered'))
    expect(() => verifyPackagedOrcadTemplate(f.resourcesDir)).toThrow()
    await expect(
      assembleOrcadArtifact({
        templateDir: f.templateDir,
        cacheRoot: join(f.appDir, 'cache'),
        target: 'linux-x64-glibc'
      })
    ).rejects.toThrow()
  })

  it.each([3, 4])('rejects arbitrary reference paths in schema %s', async (schemaVersion) => {
    const f = await fixture()
    f.manifest.schemaVersion = schemaVersion
    f.manifest.targets['linux-x64-glibc'].packagedRipgrep = '../../outside/rg'
    await writeFile(f.manifestPath, JSON.stringify(f.manifest))
    expect(() => verifyPackagedOrcadTemplate(f.resourcesDir)).toThrow(
      'Invalid packaged ripgrep reference'
    )
    await expect(
      assembleOrcadArtifact({
        templateDir: f.templateDir,
        cacheRoot: join(f.appDir, 'cache'),
        target: 'linux-x64-glibc'
      })
    ).rejects.toThrow()
  })

  it('rejects references under schema 3 and Darwin references under schema 4', async () => {
    const f = await fixture()
    for (const [schemaVersion, target] of [
      [3, 'linux-x64-glibc'],
      [4, 'darwin-arm64']
    ]) {
      const entry = f.manifest.targets[target]
      f.manifest.schemaVersion = schemaVersion
      entry.packagedRipgrep = true
      await writeFile(f.manifestPath, JSON.stringify(f.manifest))
      expect(() => verifyPackagedOrcadTemplate(f.resourcesDir)).toThrow(
        'Invalid packaged ripgrep reference'
      )
      await expect(
        assembleOrcadArtifact({
          templateDir: f.templateDir,
          cacheRoot: join(f.appDir, 'cache'),
          target
        })
      ).rejects.toThrow('Invalid packaged ripgrep reference')
      delete entry.packagedRipgrep
    }
  })

  it('rejects an extra target copy left beside a reference', async () => {
    const f = await fixture()
    compactPackagedOrcadRipgrep(f.resourcesDir)
    await copyFile(
      join(f.resourcesDir, 'ripgrep/linux-x64/rg'),
      join(f.templateDir, 'targets/linux-x64-glibc/ripgrep/linux-x64/rg')
    )
    expect(() => verifyPackagedOrcadTemplate(f.resourcesDir)).toThrow('file inventory mismatch')
  })

  it.skipIf(process.platform === 'win32')('rejects a shared symlink', async () => {
    const f = await fixture()
    const shared = join(f.resourcesDir, 'ripgrep/linux-x64/rg')
    const other = `${shared}.other`
    await copyFile(shared, other)
    await rm(shared)
    await symlink(other, shared)
    expect(() => compactPackagedOrcadRipgrep(f.resourcesDir)).toThrow('must be a regular file')
  })

  it('reseals only shared Windows binaries explicitly returned by SignPath', async () => {
    const f = await fixture()
    compactPackagedOrcadRipgrep(f.resourcesDir)
    const filename = 'ripgrep/win32-x64/rg.exe'
    const shared = join(f.resourcesDir, filename)
    await writeFile(shared, 'authenticode-signed binary')
    const list = join(f.appDir, 'inner-signing-list.txt')
    await writeFile(list, 'Orca.exe\r\n')
    expect(() => resealSignedWindowsApp(f.appDir, list)).toThrow('checksum mismatch')
    await writeFile(list, 'Orca.exe\r\nresources\\ripgrep\\win32-x64\\rg.exe\r\n')
    resealSignedWindowsApp(f.appDir, list)
    const manifest = JSON.parse(await readFile(f.manifestPath, 'utf8'))
    expect(manifest.targets['win32-x64'].files[filename]).toBe(hash(await readFile(shared)))
    await writeFile(join(f.resourcesDir, 'ripgrep/linux-x64/rg'), 'unrelated change')
    expect(() => resealSignedWindowsApp(f.appDir, list)).toThrow('checksum mismatch')
  })
})
