import { createHash } from 'node:crypto'
import 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../../src/main/orcad/artifact-slots/orcad-artifact-materializer.ts'
import '../../../../src/main/orcad/artifact-slots/orcad-artifact-identity.ts'
import {
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  orcadRipgrepArtifact
} from '../../../../src/shared/orcad-artifacts.ts'
import { writeOrcadTemplateTestFixture } from './orcad-template-test-fixture.mjs'

const require = createRequire(import.meta.url)
const { compactPackagedOrcadRipgrep } = require('./compact-packaged-orcad-ripgrep.cjs')
const { resealSignedWindowsApp } = require('./packaged-orcad-template.cjs')
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
  it('does not launder corrupted target bytes while removing duplicates', async () => {
    const f = await fixture()
    await writeFile(join(f.templateDir, 'targets/linux-x64-glibc/ripgrep/linux-x64/rg'), 'tampered')
    expect(() => compactPackagedOrcadRipgrep(f.resourcesDir)).toThrow('checksum mismatch')
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
