import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hasValidBundledMobileWebBundle } from './bundled-mobile-web-bundle'
import {
  installMobileWebBundleAppPath,
  writeSyntheticMobileWebBundle
} from './mobile-web-bundle.test-fixture'

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'orca-bundled-mobile-web-bundle-'))
  installMobileWebBundleAppPath(scratch)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('hasValidBundledMobileWebBundle', () => {
  it('returns false when out/mobile-web/manifest.json does not exist', () => {
    expect(hasValidBundledMobileWebBundle()).toBe(false)
  })

  it('returns false when manifest.json is truncated or invalid JSON', () => {
    const bundleRoot = join(scratch, 'out', 'mobile-web')
    mkdirSync(bundleRoot, { recursive: true })
    writeFileSync(join(bundleRoot, 'manifest.json'), '{"schemaVersion":1,', 'utf8')

    expect(hasValidBundledMobileWebBundle()).toBe(false)
  })

  it('returns false when manifest.json does not match the manifest contract', () => {
    const bundleRoot = join(scratch, 'out', 'mobile-web')
    mkdirSync(bundleRoot, { recursive: true })
    writeFileSync(join(bundleRoot, 'manifest.json'), JSON.stringify({ schemaVersion: 999 }), 'utf8')

    expect(hasValidBundledMobileWebBundle()).toBe(false)
  })

  it('returns true when manifest.json parses and validates, and recovers after an invalid write', () => {
    const bundleRoot = join(scratch, 'out', 'mobile-web')
    mkdirSync(bundleRoot, { recursive: true })
    writeFileSync(join(bundleRoot, 'manifest.json'), 'not-json', 'utf8')
    expect(hasValidBundledMobileWebBundle()).toBe(false)

    writeSyntheticMobileWebBundle(bundleRoot, 1)
    expect(hasValidBundledMobileWebBundle()).toBe(true)

    rmSync(join(bundleRoot, 'manifest.json'))
    expect(hasValidBundledMobileWebBundle()).toBe(false)
  })
})
