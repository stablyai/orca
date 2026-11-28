import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  hasValidBundledMobileWebBundle,
  loadBundledMobileWebBundle
} from './bundled-mobile-web-bundle'
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

  it('caches a validated manifest to avoid repeated sync reads and clears cache when async load sees it gone', async () => {
    const bundleRoot = join(scratch, 'out', 'mobile-web')
    mkdirSync(bundleRoot, { recursive: true })
    writeFileSync(join(bundleRoot, 'manifest.json'), 'not-json', 'utf8')
    expect(hasValidBundledMobileWebBundle()).toBe(false)

    writeSyntheticMobileWebBundle(bundleRoot, 1)
    expect(hasValidBundledMobileWebBundle()).toBe(true)

    // Removing the file does not trigger a repeated sync read while the validated root is cached.
    rmSync(join(bundleRoot, 'manifest.json'))
    expect(hasValidBundledMobileWebBundle()).toBe(true)

    // An async load observes the missing file and invalidates the cached verdict.
    expect(await loadBundledMobileWebBundle()).toBeNull()
    expect(hasValidBundledMobileWebBundle()).toBe(false)
  })
})
