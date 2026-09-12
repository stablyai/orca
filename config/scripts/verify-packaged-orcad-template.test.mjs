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
  it('accepts the exact eight-target packaged template', async () => {
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

  it('rejects a missing target before the package reaches deployment', async () => {
    const fixture = await createFixture()
    const manifestPath = join(fixture.templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    delete manifest.targets['win32-arm64']
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
