import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assembleOrcadArtifact } from '../../src/main/orcad/orcad-artifact-materializer.ts'
import { ORCAD_TEMPLATE_MANIFEST_FILENAME } from '../../src/shared/orcad-artifacts.ts'
import { writeOrcadTemplateTestFixture } from './orcad-template-test-fixture.mjs'

const require = createRequire(import.meta.url)
const {
  finalizePackagedOrcadTemplate,
  resealSignedWindowsApp
} = require('./packaged-orcad-template.cjs')
const roots = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function packagedApp() {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const appDir = await mkdtemp(join(tmpdir(), 'orca-packaged-browser-'))
  roots.push(appDir)
  const resourcesDir = join(appDir, 'resources')
  const templateDir = await writeOrcadTemplateTestFixture(resourcesDir)
  const driver = join(resourcesDir, 'agent-browser-win32-x64.exe')
  await writeFile(driver, 'desktop driver')
  await finalizePackagedOrcadTemplate(resourcesDir, { platform: 'win32', signMacBinary: vi.fn() })
  return {
    appDir,
    templateDir,
    driver,
    manifestPath: join(templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME)
  }
}

describe("packaged orcad uses the app's agent-browser driver (#33846)", () => {
  it("materializes the host target's slot with the driver the app ships", async () => {
    const app = await packagedApp()
    const slot = await assembleOrcadArtifact({
      templateDir: app.templateDir,
      cacheRoot: join(app.appDir, 'cache'),
      target: 'win32-x64'
    })
    expect(await readFile(join(slot, 'agent-browser-win32-x64.exe'), 'utf8')).toBe('desktop driver')
    // A target that carries its own copy keeps it.
    const manifest = JSON.parse(await readFile(app.manifestPath, 'utf8'))
    expect(manifest.targets['linux-x64-glibc'].packagedBrowser).toBeUndefined()
    expect(manifest.targets['win32-arm64'].browserName).toBeUndefined()
  })

  it('reseals the driver after SignPath rewrites it', async () => {
    const app = await packagedApp()
    await writeFile(app.driver, 'authenticode-signed driver')
    const list = join(app.appDir, 'inner-signing-list.txt')
    await writeFile(list, 'Orca.exe\r\nresources\\agent-browser-win32-x64.exe\r\n')
    resealSignedWindowsApp(app.appDir, list)
    const slot = await assembleOrcadArtifact({
      templateDir: app.templateDir,
      cacheRoot: join(app.appDir, 'cache'),
      target: 'win32-x64'
    })
    expect(await readFile(join(slot, 'agent-browser-win32-x64.exe'), 'utf8')).toBe(
      'authenticode-signed driver'
    )
  })
})
