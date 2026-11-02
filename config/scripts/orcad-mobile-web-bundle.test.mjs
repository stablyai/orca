import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ORCAD_MOBILE_WEB_MANIFEST } from '../../src/shared/orcad-artifacts.ts'
import { writeMobileWebBundleFixtureTree } from './mobile-web-bundle-fixture-tree.mjs'
import {
  readOrcadMobileWebAssetFilenames,
  stageOrcadMobileWebBundle
} from './orcad-mobile-web-bundle.mjs'

let scratch
let bundleDir
let outputDir

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'orcad-mobile-web-'))
  bundleDir = join(scratch, 'mobile-web')
  outputDir = join(scratch, 'orcad')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(scratch, { recursive: true, force: true })
})

it('stages the manifest and every asset it lists, byte for byte', async () => {
  const { manifest } = await writeMobileWebBundleFixtureTree({ outDir: bundleDir })
  stageOrcadMobileWebBundle(outputDir, bundleDir)

  const staged = readOrcadMobileWebAssetFilenames(outputDir)
  expect(staged).toHaveLength(manifest.assets.length)
  for (const asset of manifest.assets) {
    expect(readFileSync(join(outputDir, 'out', 'mobile-web', asset.path))).toEqual(
      readFileSync(join(bundleDir, asset.path))
    )
  }
  expect(readFileSync(join(outputDir, ORCAD_MOBILE_WEB_MANIFEST))).toEqual(
    readFileSync(join(bundleDir, 'manifest.json'))
  )
})

it('fails the build when the page was never built', () => {
  expect(() => stageOrcadMobileWebBundle(outputDir, bundleDir)).toThrow('pnpm build:mobile-web')
  expect(existsSync(join(outputDir, ORCAD_MOBILE_WEB_MANIFEST))).toBe(false)
})

it('ships the page the qualification lanes tested in the release template', () => {
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/node-server-tests.yml', import.meta.url), 'utf8')
  )
  const template = workflow.jobs.desktop_template
  expect(template.needs).toContain('mobile_web_bundle')
  expect(template.if).toContain("needs.mobile_web_bundle.result == 'success'")
  expect(template.steps.some((step) => step.with?.name === 'orcad-mobile-web-bundle')).toBe(true)
  expect(template.steps.some((step) => step.uses?.includes('build-mobile-web-bundle'))).toBe(false)
})
