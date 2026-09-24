import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  ORCAD_TEMPLATE_TARGETS_DIR
} from '../../src/shared/orcad-artifacts.ts'
import { writeOrcadTemplateTestFixture } from './orcad-template-test-fixture.mjs'

const require = createRequire(import.meta.url)
const { verifyPackagedOrcadTemplate } = require('./verify-packaged-orcad-template.cjs')
const builderConfig = require('../electron-builder.config.cjs')
const { getFileMatchers, copyFiles } = require('app-builder-lib/out/fileMatcher.js')
const roots = []

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-packaged-orcad-template-'))
  roots.push(root)
  const templateDir = await writeOrcadTemplateTestFixture(root)
  return { root, templateDir }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('verifyPackagedOrcadTemplate', () => {
  it.each(['mac', 'linux', 'win'])(
    'preserves the template through the actual %s resource copier',
    async (platform) => {
      const root = await mkdtemp(join(tmpdir(), 'orca-template-copy-'))
      roots.push(root)
      await writeOrcadTemplateTestFixture(join(root, 'out'))
      const resourcesDir = join(root, 'resources')
      const extraResources = builderConfig[platform].extraResources.filter(
        (resource) => typeof resource === 'object' && resource.to.startsWith('orcad-template')
      )
      const matchers = getFileMatchers({ extraResources }, 'extraResources', resourcesDir, {
        macroExpander: (value) => value,
        customBuildOptions: {},
        defaultSrc: root,
        globalOutDir: join(root, 'dist')
      })
      await copyFiles(matchers, undefined, false)
      expect(() => verifyPackagedOrcadTemplate(resourcesDir)).not.toThrow()
    }
  )

  it('accepts the exact six-target packaged template', async () => {
    const fixture = await createFixture()

    expect(() => verifyPackagedOrcadTemplate(fixture.root)).not.toThrow()
  })

  it('rejects target-native bytes changed after manifest generation', async () => {
    const fixture = await createFixture()
    await writeFile(
      join(fixture.templateDir, ORCAD_TEMPLATE_TARGETS_DIR, 'linux-x64-glibc', 'watcher.node'),
      'mutated'
    )

    expect(() => verifyPackagedOrcadTemplate(fixture.root)).toThrow(
      'linux-x64-glibc watcher checksum mismatch'
    )
  })

  it('rejects a missing Windows PTY gate worker', async () => {
    const fixture = await createFixture()
    await rm(join(fixture.templateDir, 'windows-bun-pty-gate-entry.js'))

    expect(() => verifyPackagedOrcadTemplate(fixture.root)).toThrow('windows-bun-pty-gate-entry.js')
  })

  it.each(['writer', 'backup'])(
    'requires the profile %s worker and its exact bytes',
    async (role) => {
      const fixture = await createFixture()
      const filename = `profile-state-${role}-worker-entry.js`
      await writeFile(join(fixture.templateDir, filename), 'stale-worker')
      expect(() => verifyPackagedOrcadTemplate(fixture.root)).toThrow(
        `${filename} checksum mismatch`
      )
      await rm(join(fixture.templateDir, filename))
      expect(() => verifyPackagedOrcadTemplate(fixture.root)).toThrow(`missing ${filename}`)
    }
  )

  it('rejects a missing target before the package reaches deployment', async () => {
    const fixture = await createFixture()
    const manifestPath = join(fixture.templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    delete manifest.targets['linux-arm64-musl']
    await writeFile(manifestPath, JSON.stringify(manifest))

    expect(() => verifyPackagedOrcadTemplate(fixture.root)).toThrow(
      'target manifest inventory mismatch'
    )
  })

  it('keeps the verifier connected to every packaged platform', async () => {
    const configSource = await readFile(
      join(process.cwd(), 'config', 'electron-builder.config.cjs'),
      'utf8'
    )
    const config = require('../electron-builder.config.cjs')

    expect(configSource).toContain("require('./scripts/verify-packaged-orcad-template.cjs')")
    expect(configSource).toContain('verifyPackagedOrcadTemplate(resourcesDir)')
    for (const platform of ['win', 'mac', 'linux']) {
      expect(config[platform].extraResources).toEqual(
        expect.arrayContaining([expect.objectContaining({ to: 'orcad-template' })])
      )
    }
  })
})
