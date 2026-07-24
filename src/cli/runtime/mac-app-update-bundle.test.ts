import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAC_BUNDLE_INFO_PLIST_MAX_BYTES, waitForMacBundleVersion } from './mac-app-update-bundle'

const roots: string[] = []

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const originalPlatform = process.platform

describe('waitForMacBundleVersion', () => {
  it('rejects a sparse oversized Info.plist without reading its payload', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const root = mkdtempSync(join(tmpdir(), 'orca-mac-bundle-bounds-'))
    roots.push(root)
    const contentsPath = join(root, 'Orca.app', 'Contents')
    const executable = join(contentsPath, 'MacOS', 'Orca')
    mkdirSync(join(contentsPath, 'MacOS'), { recursive: true })
    writeFileSync(executable, '')
    const plistPath = join(contentsPath, 'Info.plist')
    writeFileSync(plistPath, '')
    truncateSync(plistPath, MAC_BUNDLE_INFO_PLIST_MAX_BYTES + 1)

    await expect(waitForMacBundleVersion(executable, '1.2.3', 1)).resolves.toBe(false)
  })
})
