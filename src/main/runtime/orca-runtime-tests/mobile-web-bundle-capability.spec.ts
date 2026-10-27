import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntime } from '../orca-runtime-test-fixtures.spec'
import { resetBundledMobileWebBundleCacheForTests } from '../bundled-mobile-web-bundle'
import {
  installMobileWebBundleAppPath,
  writeSyntheticMobileWebBundle
} from '../rpc/methods/mobile-web-bundle.test-fixture'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../shared/mobile-web-bundle/mobile-web-bundle-capability'

// The aggregate shares this process cache; each fixture must restore it.
function statusCapabilitiesForInstall(appPath: string): readonly string[] {
  resetBundledMobileWebBundleCacheForTests()
  installMobileWebBundleAppPath(appPath)
  const { capabilities } = createRuntime().getStatus()
  if (!capabilities) {
    // A missing capability list would make absence assertions pass vacuously.
    throw new Error('status.get answered no capability list')
  }
  return capabilities
}

function withInstallRoot(prefix: string, run: (install: string) => void): void {
  const install = mkdtempSync(join(tmpdir(), prefix))
  try {
    run(install)
  } finally {
    rmSync(install, { recursive: true, force: true })
  }
}

describe('OrcaRuntimeService mobile web bundle capability', () => {
  afterEach(() => {
    resetBundledMobileWebBundleCacheForTests()
  })

  it('omits the mobile web bundle capability where the install carries no bundle', () => {
    withInstallRoot('orca-mobile-web-absent-', (install) => {
      expect(statusCapabilitiesForInstall(install)).not.toContain(MOBILE_WEB_BUNDLE_CAPABILITY)
    })
  })

  it('advertises the mobile web bundle capability where the install carries one', () => {
    withInstallRoot('orca-mobile-web-present-', (install) => {
      writeSyntheticMobileWebBundle(join(install, 'out', 'mobile-web'), 4)
      expect(statusCapabilitiesForInstall(install)).toContain(MOBILE_WEB_BUNDLE_CAPABILITY)
    })
  })

  it('omits the capability where the bundle manifest does not parse', () => {
    withInstallRoot('orca-mobile-web-unparseable-', (install) => {
      const root = join(install, 'out', 'mobile-web')
      writeSyntheticMobileWebBundle(root, 5)
      writeFileSync(join(root, 'manifest.json'), '{"schemaVersion":2}', 'utf8')
      expect(statusCapabilitiesForInstall(install)).not.toContain(MOBILE_WEB_BUNDLE_CAPABILITY)
    })
  })
})
